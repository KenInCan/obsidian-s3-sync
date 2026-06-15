export interface S3ObjectMetadata {
	key: string;
	lastModified: string;
	etag: string;
	size: number;
}

/**
 * Normalizes an Obsidian vault path (removes leading/trailing slashes, replaces backslashes).
 */
export function normalizePath(path: string): string {
	let normalized = path.replace(/\\/g, '/');
	// Remove leading slash
	if (normalized.startsWith('/')) {
		normalized = normalized.substring(1);
	}
	// Remove trailing slash
	if (normalized.endsWith('/')) {
		normalized = normalized.substring(0, normalized.length - 1);
	}
	return normalized;
}

/**
 * Converts a vault-relative path to an S3 key.
 */
export function pathToS3Key(path: string, prefix?: string): string {
	const normPath = normalizePath(path);
	if (!prefix) return normPath;
	const normPrefix = normalizePath(prefix);
	return normPrefix ? `${normPrefix}/${normPath}` : normPath;
}

/**
 * Converts an S3 key back to a vault-relative path.
 */
export function s3KeyToPath(key: string, prefix?: string): string {
	const normKey = normalizePath(key);
	if (!prefix) return normKey;
	const normPrefix = normalizePath(prefix);
	if (!normPrefix) return normKey;

	if (normKey.startsWith(normPrefix + '/')) {
		return normKey.substring(normPrefix.length + 1);
	}
	return normKey;
}

/**
 * Parses S3 ListObjectsV2 XML response using browser DOMParser.
 */
export function parseS3ListObjects(xmlString: string): {
	contents: S3ObjectMetadata[];
	isTruncated: boolean;
	nextContinuationToken?: string;
} {
	const parser = new DOMParser();
	const xmlDoc = parser.parseFromString(xmlString, 'text/xml');
	const contents: S3ObjectMetadata[] = [];
	
	const contentNodes = xmlDoc.getElementsByTagName('Contents');
	for (let i = 0; i < contentNodes.length; i++) {
		const node = contentNodes[i];
		const key = node.getElementsByTagName('Key')[0]?.textContent || '';
		const lastModified = node.getElementsByTagName('LastModified')[0]?.textContent || '';
		const etagRaw = node.getElementsByTagName('ETag')[0]?.textContent || '';
		// Strip quotes from ETag
		const etag = etagRaw.replace(/^"|"$/g, '');
		const sizeStr = node.getElementsByTagName('Size')[0]?.textContent || '0';
		const size = parseInt(sizeStr, 10);
		
		contents.push({ key, lastModified, etag, size });
	}
	
	const isTruncated = xmlDoc.getElementsByTagName('IsTruncated')[0]?.textContent === 'true';
	const nextContinuationToken = xmlDoc.getElementsByTagName('NextContinuationToken')[0]?.textContent || undefined;
	
	return { contents, isTruncated, nextContinuationToken };
}

/**
 * Parses S3 XML Error response.
 */
export function parseS3Error(xmlString: string): { code: string; message: string } {
	try {
		const parser = new DOMParser();
		const xmlDoc = parser.parseFromString(xmlString, 'text/xml');
		const code = xmlDoc.getElementsByTagName('Code')[0]?.textContent || 'UnknownError';
		const message = xmlDoc.getElementsByTagName('Message')[0]?.textContent || 'An unknown S3 error occurred';
		return { code, message };
	} catch {
		return { code: 'UnknownError', message: xmlString };
	}
}

/**
 * Standard MD5 implementation in pure JavaScript (supports ArrayBuffer).
 */
export function md5(data: ArrayBuffer | Uint8Array | string): string {
	let bytes: Uint8Array;
	if (typeof data === 'string') {
		bytes = new TextEncoder().encode(data);
	} else if (data instanceof ArrayBuffer) {
		bytes = new Uint8Array(data);
	} else {
		bytes = data;
	}

	const safe_add = (x: number, y: number): number => {
		const lsw = (x & 0xffff) + (y & 0xffff);
		const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
		return (msw << 16) | (lsw & 0xffff);
	};

	const bit_rol = (num: number, cnt: number): number => {
		return (num << cnt) | (num >>> (32 - cnt));
	};

	const md5cmn = (q: number, a: number, b: number, x: number, s: number, t: number): number => {
		return safe_add(bit_rol(safe_add(safe_add(a, q), safe_add(x, t)), s), b);
	};

	const md5ff = (a: number, b: number, c: number, d: number, x: number, s: number, t: number): number => {
		return md5cmn((b & c) | (~b & d), a, b, x, s, t);
	};

	const md5gg = (a: number, b: number, c: number, d: number, x: number, s: number, t: number): number => {
		return md5cmn((b & d) | (c & ~d), a, b, x, s, t);
	};

	const md5hh = (a: number, b: number, c: number, d: number, x: number, s: number, t: number): number => {
		return md5cmn(b ^ c ^ d, a, b, x, s, t);
	};

	const md5ii = (a: number, b: number, c: number, d: number, x: number, s: number, t: number): number => {
		return md5cmn(c ^ (b | ~d), a, b, x, s, t);
	};

	// Convert bytes to 32-bit words (little-endian)
	const blocks: number[] = [];
	const len = bytes.length;
	for (let i = 0; i < len; i++) {
		const index = i >> 2;
		blocks[index] = (blocks[index] || 0) | (bytes[i] << ((i & 3) << 3));
	}

	// Pad message
	const bitLen = len * 8;
	const padIndex = len >> 2;
	blocks[padIndex] = (blocks[padIndex] || 0) | (0x80 << ((len & 3) << 3));

	const blockCount = ((len + 8) >> 6) + 1;
	const blockWordCount = blockCount * 16;
	while (blocks.length < blockWordCount) {
		blocks.push(0);
	}
	blocks[blockWordCount - 2] = bitLen & 0xffffffff;
	blocks[blockWordCount - 1] = Math.floor(bitLen / 0x100000000);

	let a = 1732584193;
	let b = -271733879;
	let c = -1732584194;
	let d = 271733878;

	for (let i = 0; i < blocks.length; i += 16) {
		const olda = a;
		const oldb = b;
		const oldc = c;
		const oldd = d;

		// Round 1
		a = md5ff(a, b, c, d, blocks[i + 0], 7, -680876936);
		d = md5ff(d, a, b, c, blocks[i + 1], 12, -389564586);
		c = md5ff(c, d, a, b, blocks[i + 2], 17, 606105819);
		b = md5ff(b, c, d, a, blocks[i + 3], 22, -1044525330);
		a = md5ff(a, b, c, d, blocks[i + 4], 7, -176418897);
		d = md5ff(d, a, b, c, blocks[i + 5], 12, 1200080426);
		c = md5ff(c, d, a, b, blocks[i + 6], 17, -1473231341);
		b = md5ff(b, c, d, a, blocks[i + 7], 22, -45705983);
		a = md5ff(a, b, c, d, blocks[i + 8], 7, 1770035416);
		d = md5ff(d, a, b, c, blocks[i + 9], 12, -1958414417);
		c = md5ff(c, d, a, b, blocks[i + 10], 17, -42063);
		b = md5ff(b, c, d, a, blocks[i + 11], 22, -1990404162);
		a = md5ff(a, b, c, d, blocks[i + 12], 7, 1804603682);
		d = md5ff(d, a, b, c, blocks[i + 13], 12, -40341101);
		c = md5ff(c, d, a, b, blocks[i + 14], 17, -1502002290);
		b = md5ff(b, c, d, a, blocks[i + 15], 22, 1236535329);

		// Round 2
		a = md5gg(a, b, c, d, blocks[i + 1], 5, -165796510);
		d = md5gg(d, a, b, c, blocks[i + 6], 9, -1069501632);
		c = md5gg(c, d, a, b, blocks[i + 11], 14, 643717713);
		b = md5gg(b, c, d, a, blocks[i + 0], 20, -373897302);
		a = md5gg(a, b, c, d, blocks[i + 5], 5, -701558691);
		d = md5gg(d, a, b, c, blocks[i + 10], 9, 38016083);
		c = md5gg(c, d, a, b, blocks[i + 15], 14, -660478335);
		b = md5gg(b, c, d, a, blocks[i + 4], 20, -405537848);
		a = md5gg(a, b, c, d, blocks[i + 9], 5, 568446438);
		d = md5gg(d, a, b, c, blocks[i + 14], 9, -1019803690);
		c = md5gg(c, d, a, b, blocks[i + 3], 14, -187363961);
		b = md5gg(b, c, d, a, blocks[i + 8], 20, 1163531501);
		a = md5gg(a, b, c, d, blocks[i + 13], 5, -1444681467);
		d = md5gg(d, a, b, c, blocks[i + 2], 9, -51403784);
		c = md5gg(c, d, a, b, blocks[i + 7], 14, 1735328473);
		b = md5gg(b, c, d, a, blocks[i + 12], 20, -1926607734);

		// Round 3
		a = md5hh(a, b, c, d, blocks[i + 5], 4, -378558);
		d = md5hh(d, a, b, c, blocks[i + 8], 11, -2022574463);
		c = md5hh(c, d, a, b, blocks[i + 11], 16, 1839030562);
		b = md5hh(b, c, d, a, blocks[i + 14], 23, -35309556);
		a = md5hh(a, b, c, d, blocks[i + 1], 4, -1530992060);
		d = md5hh(d, a, b, c, blocks[i + 4], 11, 1272893353);
		c = md5hh(c, d, a, b, blocks[i + 7], 16, -155497632);
		b = md5hh(b, c, d, a, blocks[i + 10], 23, -1094730640);
		a = md5hh(a, b, c, d, blocks[i + 13], 4, 681279174);
		d = md5hh(d, a, b, c, blocks[i + 0], 11, -358537222);
		c = md5hh(c, d, a, b, blocks[i + 3], 16, -722521979);
		b = md5hh(b, c, d, a, blocks[i + 6], 23, 76029189);
		a = md5hh(a, b, c, d, blocks[i + 9], 4, -640364487);
		d = md5hh(d, a, b, c, blocks[i + 12], 11, -421815835);
		c = md5hh(c, d, a, b, blocks[i + 15], 16, 530742520);
		b = md5hh(b, c, d, a, blocks[i + 2], 23, -995338651);

		// Round 4
		a = md5ii(a, b, c, d, blocks[i + 0], 6, -198630844);
		d = md5ii(d, a, b, c, blocks[i + 7], 10, 1126891415);
		c = md5ii(c, d, a, b, blocks[i + 14], 15, -1416354905);
		b = md5ii(b, c, d, a, blocks[i + 5], 21, -57434055);
		a = md5ii(a, b, c, d, blocks[i + 12], 6, 1700485571);
		d = md5ii(d, a, b, c, blocks[i + 3], 10, -1894986606);
		c = md5ii(c, d, a, b, blocks[i + 10], 15, -1051523);
		b = md5ii(b, c, d, a, blocks[i + 1], 21, -2054922799);
		a = md5ii(a, b, c, d, blocks[i + 8], 6, 1873313359);
		d = md5ii(d, a, b, c, blocks[i + 15], 10, -30611744);
		c = md5ii(c, d, a, b, blocks[i + 6], 15, -1560198380);
		b = md5ii(b, c, d, a, blocks[i + 13], 21, 1309151649);
		a = md5ii(a, b, c, d, blocks[i + 4], 6, -145523070);
		d = md5ii(d, a, b, c, blocks[i + 11], 10, -1120210379);
		c = md5ii(c, d, a, b, blocks[i + 2], 15, 718787259);
		b = md5ii(b, c, d, a, blocks[i + 9], 21, -343485551);

		a = safe_add(a, olda);
		b = safe_add(b, oldb);
		c = safe_add(c, oldc);
		d = safe_add(d, oldd);
	}

	const hex = (num: number): string => {
		let str = '';
		for (let j = 0; j < 4; j++) {
			str += ((num >> (j * 8)) & 0xff).toString(16).padStart(2, '0');
		}
		return str;
	};

	return hex(a) + hex(b) + hex(c) + hex(d);
}

/**
 * Checks if a given path is excluded based on the excluded paths setting string.
 * Each line in the setting represents a rule.
 * Slashes are normalized. Lines starting with # are comments.
 */
export function isPathExcluded(path: string, excludedPathsSetting: string): boolean {
	if (!excludedPathsSetting) return false;
	const rules = excludedPathsSetting
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith('#'));

	const normalizedPath = normalizePath(path);

	for (const rule of rules) {
		const normalizedRule = normalizePath(rule);
		if (!normalizedRule) continue;

		if (normalizedPath === normalizedRule || normalizedPath.startsWith(normalizedRule + '/')) {
			return true;
		}
	}
	return false;
}

