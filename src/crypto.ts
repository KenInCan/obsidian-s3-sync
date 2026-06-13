/**
 * Derives a 256-bit AES-GCM key from a passphrase and bucket name using PBKDF2.
 */
export async function deriveKey(passphrase: string, bucketName: string): Promise<CryptoKey> {
	const pwBytes = new TextEncoder().encode(passphrase);
	const bucketBytes = new TextEncoder().encode(bucketName);

	// Generate salt by hashing the bucket name (ensures consistent salt across devices)
	const salt = await window.crypto.subtle.digest('SHA-256', bucketBytes);

	// Import the raw passphrase as key material
	const keyMaterial = await window.crypto.subtle.importKey(
		'raw',
		pwBytes,
		'PBKDF2',
		false,
		['deriveKey']
	);

	// Derive the AES-GCM 256 key
	return await window.crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			salt: salt,
			iterations: 100000,
			hash: 'SHA-256',
		},
		keyMaterial,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

/**
 * Compresses an ArrayBuffer using native CompressionStream (Gzip).
 */
export async function compressBuffer(buffer: ArrayBuffer): Promise<ArrayBuffer> {
	const stream = new Response(buffer).body!.pipeThrough(new CompressionStream('gzip'));
	return await new Response(stream).arrayBuffer();
}

/**
 * Decompresses an ArrayBuffer using native DecompressionStream (Gzip).
 */
export async function decompressBuffer(buffer: ArrayBuffer): Promise<ArrayBuffer> {
	const stream = new Response(buffer).body!.pipeThrough(new DecompressionStream('gzip'));
	return await new Response(stream).arrayBuffer();
}

/**
 * Encrypts an ArrayBuffer using AES-GCM-256, optionally compressing it first.
 * Prepend the 12-byte IV to the output payload. If mtime is provided, it prepends
 * a 13-byte "SYNC" magic prefix (version 1) containing the local Float64 mtime.
 */
export async function encryptBuffer(
	buffer: ArrayBuffer,
	key: CryptoKey,
	compress: boolean,
	mtime?: number
): Promise<ArrayBuffer> {
	let dataToEncrypt = buffer;
	if (mtime !== undefined) {
		const header = new ArrayBuffer(13);
		const view = new DataView(header);
		// Write magic bytes "SYNC"
		view.setUint8(0, 0x53); // 'S'
		view.setUint8(1, 0x59); // 'Y'
		view.setUint8(2, 0x4e); // 'N'
		view.setUint8(3, 0x43); // 'C'
		// Write format version 1
		view.setUint8(4, 1);
		// Write mtime (8 bytes)
		view.setFloat64(5, mtime);

		const combined = new Uint8Array(13 + buffer.byteLength);
		combined.set(new Uint8Array(header), 0);
		combined.set(new Uint8Array(buffer), 13);
		dataToEncrypt = combined.buffer;
	}

	if (compress) {
		dataToEncrypt = await compressBuffer(dataToEncrypt);
	}

	const iv = window.crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await window.crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv: iv,
		},
		key,
		dataToEncrypt
	);

	// Combine IV + Ciphertext
	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(ciphertext), iv.length);

	return combined.buffer;
}

/**
 * Decrypts an ArrayBuffer using AES-GCM-256, optionally decompressing it afterwards.
 * Extracts the 12-byte IV from the start of the payload.
 * Automatically detects and extracts the 13-byte "SYNC" metadata header if present.
 */
export async function decryptBuffer(
	buffer: ArrayBuffer,
	key: CryptoKey,
	decompress: boolean
): Promise<{ decrypted: ArrayBuffer; mtime?: number }> {
	const bytes = new Uint8Array(buffer);
	if (bytes.length < 12) {
		throw new Error('Payload too short (missing encryption metadata)');
	}

	const iv = bytes.slice(0, 12);
	const ciphertext = bytes.slice(12);

	let decrypted: ArrayBuffer;
	try {
		decrypted = await window.crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: iv,
			},
			key,
			ciphertext.buffer
		);
	} catch (err) {
		throw new Error('Decryption failed. Please check if your Encryption Passphrase is correct.');
	}

	let decompressed = decrypted;
	if (decompress) {
		decompressed = await decompressBuffer(decrypted);
	}

	// Check for magic header "SYNC" (version 1)
	if (decompressed.byteLength >= 13) {
		const view = new DataView(decompressed);
		const isMagic = view.getUint8(0) === 0x53 && // 'S'
		                view.getUint8(1) === 0x59 && // 'Y'
		                view.getUint8(2) === 0x4e && // 'N'
		                view.getUint8(3) === 0x43;   // 'C'
		const version = view.getUint8(4);

		if (isMagic && version === 1) {
			const mtime = view.getFloat64(5);
			const content = decompressed.slice(13);
			return { decrypted: content, mtime };
		}
	}

	return { decrypted: decompressed };
}

/**
 * Encrypts a vault file path string using a deterministic IV derived from the path itself.
 * Returns the hex representation of [12-byte IV] + [Ciphertext].
 */
export async function encryptPath(path: string, key: CryptoKey): Promise<string> {
	const pathBytes = new TextEncoder().encode(path);
	
	// Compute deterministic IV from the path string using SHA-256
	const hashBuffer = await window.crypto.subtle.digest('SHA-256', pathBytes);
	const iv = new Uint8Array(hashBuffer).slice(0, 12);
	
	const ciphertext = await window.crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv: iv,
		},
		key,
		pathBytes
	);
	
	// Convert IV + Ciphertext to Hex
	const combined = new Uint8Array(iv.length + ciphertext.byteLength);
	combined.set(iv, 0);
	combined.set(new Uint8Array(ciphertext), iv.length);
	
	return Array.from(combined)
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Decrypts an encrypted hex path string back to its original plaintext representation.
 */
export async function decryptPath(encryptedPath: string, key: CryptoKey): Promise<string> {
	if (encryptedPath.length < 56) {
		throw new Error('Encrypted path is too short');
	}
	
	const matches = encryptedPath.match(/.{1,2}/g);
	if (!matches) {
		throw new Error('Invalid hex string format for encrypted path');
	}
	const bytes = new Uint8Array(matches.map(byte => parseInt(byte, 16)));
	
	const iv = bytes.slice(0, 12);
	const ciphertext = bytes.slice(12);
	
	const decrypted = await window.crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: iv,
		},
		key,
		ciphertext.buffer
	);
	
	return new TextDecoder().decode(decrypted);
}

