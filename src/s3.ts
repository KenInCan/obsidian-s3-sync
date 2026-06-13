import { requestUrl } from 'obsidian';
import { S3ObjectMetadata, parseS3ListObjects, parseS3Error, normalizePath, pathToS3Key } from './utils';

export interface S3ClientConfig {
	endpointUrl?: string; // Optional, custom endpoint (e.g. Backblaze R2, MinIO)
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
}

/**
 * Custom self-contained S3 client implementing AWS Signature Version 4.
 */
export class S3Client {
	private config: S3ClientConfig;

	constructor(config: S3ClientConfig) {
		this.config = config;
	}

	/**
	 * Lists all objects in the bucket matching the specified prefix.
	 */
	async listObjects(prefix?: string, continuationToken?: string): Promise<{
		contents: S3ObjectMetadata[];
		isTruncated: boolean;
		nextContinuationToken?: string;
	}> {
		const queryParams: Record<string, string> = { 'list-type': '2' };
		if (prefix) {
			const normPrefix = normalizePath(prefix);
			if (normPrefix) {
				queryParams['prefix'] = normPrefix + '/';
			}
		}
		if (continuationToken) {
			queryParams['continuation-token'] = continuationToken;
		}

		const response = await this.sendRequest('GET', '', undefined, queryParams);
		if (response.status !== 200) {
			const text = new TextDecoder().decode(response.arrayBuffer);
			const err = parseS3Error(text);
			throw new Error(`S3 ListObjects failed: [${err.code}] ${err.message}`);
		}

		const xmlText = new TextDecoder().decode(response.arrayBuffer);
		return parseS3ListObjects(xmlText);
	}

	/**
	 * Downloads an object's contents from S3.
	 */
	async getObject(key: string): Promise<ArrayBuffer> {
		const response = await this.sendRequest('GET', key);
		if (response.status === 404) {
			throw new Error(`S3 GetObject failed: File not found (${key})`);
		}
		if (response.status !== 200) {
			const text = new TextDecoder().decode(response.arrayBuffer);
			const err = parseS3Error(text);
			throw new Error(`S3 GetObject failed: [${err.code}] ${err.message}`);
		}
		return response.arrayBuffer;
	}

	/**
	 * Uploads an object's contents to S3. Returns the ETag of the uploaded object.
	 */
	async putObject(key: string, body: ArrayBuffer): Promise<string> {
		const response = await this.sendRequest('PUT', key, body);
		if (response.status !== 200) {
			const text = new TextDecoder().decode(response.arrayBuffer);
			const err = parseS3Error(text);
			throw new Error(`S3 PutObject failed: [${err.code}] ${err.message}`);
		}
		
		const etagRaw = response.headers['etag'] || response.headers['ETag'] || '';
		return etagRaw.replace(/^"|"$/g, '');
	}

	/**
	 * Deletes an object from S3.
	 */
	async deleteObject(key: string): Promise<void> {
		const response = await this.sendRequest('DELETE', key);
		if (response.status !== 200 && response.status !== 204) {
			const text = new TextDecoder().decode(response.arrayBuffer);
			const err = parseS3Error(text);
			throw new Error(`S3 DeleteObject failed: [${err.code}] ${err.message}`);
		}
	}

	/**
	 * Builds and sends a signed S3 V4 request.
	 */
	private async sendRequest(
		method: 'GET' | 'PUT' | 'DELETE',
		key: string,
		body?: ArrayBuffer,
		queryParams: Record<string, string> = {}
	) {
		const { endpointUrl, region, bucket } = this.config;
		
		// 1. Determine Endpoint Style and URL
		let host = '';
		let requestUrlStr = '';
		let canonicalUri = '';

		const s3Key = pathToS3Key(key);
		const escapedKey = s3Key.split('/').map(part => encodeURIComponent(part)).join('/');

		if (endpointUrl) {
			// Custom Endpoint (usually path-style, e.g., https://endpoint-domain.com/bucket/key)
			const endpoint = endpointUrl.replace(/\/$/, '');
			const urlObj = new URL(endpoint);
			host = urlObj.host;
			canonicalUri = `/${bucket}/${escapedKey}`;
			requestUrlStr = `${endpoint}/${bucket}/${escapedKey}`;
		} else {
			// AWS Standard S3 (virtual-host style, e.g., https://bucket.s3.region.amazonaws.com/key)
			host = `${bucket}.s3.${region}.amazonaws.com`;
			canonicalUri = `/${escapedKey}`;
			requestUrlStr = `https://${host}/${escapedKey}`;
		}

		// 2. Setup date stamps
		const now = new Date();
		const amzDate = now.toISOString().replace(/[:-]/g, '').split('.')[0] + 'Z';
		const dateStamp = amzDate.substring(0, 8);

		// 3. Compute request body hash
		const sha256Hex = async (data: ArrayBuffer | undefined): Promise<string> => {
			if (!data || data.byteLength === 0) {
				return 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // sha256("")
			}
			const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
			return Array.from(new Uint8Array(hashBuffer))
				.map(b => b.toString(16).padStart(2, '0'))
				.join('');
		};
		const payloadHash = await sha256Hex(body);

		// 4. Build headers to sign
		const headers: Record<string, string> = {
			'host': host,
			'x-amz-content-sha256': payloadHash,
			'x-amz-date': amzDate,
		};
		
		if (method === 'PUT') {
			headers['content-type'] = 'application/octet-stream';
		}

		// 5. Construct Canonical Query String
		const queryKeys = Object.keys(queryParams).sort();
		const canonicalQueryString = queryKeys
			.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
			.join('&');

		if (canonicalQueryString) {
			requestUrlStr += `?${canonicalQueryString}`;
		}

		// 6. Construct Canonical Headers & Signed Headers
		const signedHeadersList = Object.keys(headers).sort();
		const signedHeaders = signedHeadersList.join(';');
		const canonicalHeaders = signedHeadersList
			.map(k => `${k}:${headers[k].trim()}\n`)
			.join('');

		// 7. Canonical Request
		const canonicalRequest = [
			method,
			canonicalUri,
			canonicalQueryString,
			canonicalHeaders,
			signedHeaders,
			payloadHash,
		].join('\n');

		const canonicalRequestHash = Array.from(
			new Uint8Array(await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))
		).map(b => b.toString(16).padStart(2, '0')).join('');

		// 8. String to Sign
		const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
		const stringToSign = [
			'AWS4-HMAC-SHA256',
			amzDate,
			credentialScope,
			canonicalRequestHash,
		].join('\n');

		// 9. Derive Signing Key & Signature
		const hmacSha256 = async (key: CryptoKey | Uint8Array, data: string | Uint8Array): Promise<Uint8Array> => {
			let cryptoKey: CryptoKey;
			if (key instanceof Uint8Array) {
				cryptoKey = await window.crypto.subtle.importKey(
					'raw',
					key as any,
					{ name: 'HMAC', hash: 'SHA-256' },
					false,
					['sign']
				);
			} else {
				cryptoKey = key;
			}
			const dataBytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
			const signature = await window.crypto.subtle.sign('HMAC', cryptoKey, dataBytes as any);
			return new Uint8Array(signature);
		};

		const secretBytes = new TextEncoder().encode('AWS4' + this.config.secretAccessKey);
		const kDate = await hmacSha256(secretBytes, dateStamp);
		const kRegion = await hmacSha256(kDate, region);
		const kService = await hmacSha256(kRegion, 's3');
		const kSigning = await hmacSha256(kService, 'aws4_request');
		const signatureBytes = await hmacSha256(kSigning, stringToSign);
		const signature = Array.from(signatureBytes).map(b => b.toString(16).padStart(2, '0')).join('');

		// 10. Add Authorization Header
		headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

		// Don't pass the forbidden Host header to requestUrl (Electron rejects manual Host headers)
		delete headers['host'];
		delete headers['Host'];

		// 11. Send HTTPS request via Obsidian's CORS-bypassing requestUrl
		const requestParams = {
			url: requestUrlStr,
			method: method,
			headers: headers,
			body: body,
			throw: false, // Let us inspect status code ourselves
		};

		return await requestUrl(requestParams);
	}
}
