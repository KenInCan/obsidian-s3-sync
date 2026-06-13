import { App, Notice, TFile, TFolder } from 'obsidian';
// @ts-ignore
import { diff3Merge } from 'node-diff3';
import { S3Client, S3ClientConfig } from './s3';
import { deriveKey, encryptBuffer, decryptBuffer, encryptPath, decryptPath } from './crypto';
import { normalizePath, pathToS3Key, s3KeyToPath, md5 } from './utils';

export interface SyncSettings {
	endpointUrl: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	prefix: string;
	deviceName: string;
	encrypt: boolean;
	passphrase: string;
	compress: boolean;
	autoSyncInterval: number;
	syncOnStartup: boolean;
}

export interface FileSyncState {
	mtime: number;
	etag: string;
	size: number;
}

export interface SyncDatabase {
	files: Record<string, FileSyncState>;
}

export class S3SyncManager {
	private app: App;
	private settings: SyncSettings;
	private syncDb: SyncDatabase;
	private saveDbCallback: (db: SyncDatabase) => Promise<void>;
	private updateStatusCallback: (status: string) => void;
	
	private isSyncing = false;
	private CACHE_DIR = '.obsidian/s3-sync-cache';

	constructor(
		app: App,
		settings: SyncSettings,
		syncDb: SyncDatabase,
		saveDbCallback: (db: SyncDatabase) => Promise<void>,
		updateStatusCallback: (status: string) => void
	) {
		this.app = app;
		this.settings = settings;
		this.syncDb = syncDb;
		this.saveDbCallback = saveDbCallback;
		this.updateStatusCallback = updateStatusCallback;
	}

	/**
	 * Run the synchronization cycle.
	 */
	async sync(): Promise<void> {
		if (this.isSyncing) {
			console.log('S3 Sync already in progress, skipping...');
			return;
		}

		// Validate credentials first
		if (!this.settings.bucket || !this.settings.accessKeyId || !this.settings.secretAccessKey) {
			this.updateStatusCallback('Configuration Error');
			return;
		}

		this.isSyncing = true;
		this.updateStatusCallback('Syncing...');
		new Notice('S3 Sync: Starting sync...');

		try {
			// 1. Derive Key if encryption is enabled
			let cryptoKey: CryptoKey | null = null;
			if (this.settings.encrypt) {
				if (!this.settings.passphrase) {
					throw new Error('Encryption is enabled but no passphrase is set.');
				}
				cryptoKey = await deriveKey(this.settings.passphrase, this.settings.bucket);
			}

			// 2. Instantiate S3 Client
			const s3Client = new S3Client({
				endpointUrl: this.settings.endpointUrl,
				region: this.settings.region || 'us-east-1',
				bucket: this.settings.bucket,
				accessKeyId: this.settings.accessKeyId,
				secretAccessKey: this.settings.secretAccessKey,
			});

			// 3. Gather Remote S3 State
			const remoteFiles: Record<string, { etag: string; size: number; key: string; lastModified: string }> = {};
			let continuationToken: string | undefined = undefined;
			do {
				const listResult = await s3Client.listObjects(this.settings.prefix, continuationToken);
				for (const obj of listResult.contents) {
					// Get vault-relative path from S3 key
					let path = s3KeyToPath(obj.key, this.settings.prefix);
					if (path) {
						if (this.settings.encrypt && cryptoKey) {
							try {
								path = await decryptPath(path, cryptoKey);
							} catch (e) {
								console.warn(`S3 Sync: Failed to decrypt remote path '${path}', skipping. Error:`, e);
								continue;
							}
						}
						remoteFiles[path] = { etag: obj.etag, size: obj.size, key: obj.key, lastModified: obj.lastModified };
					}
				}
				continuationToken = listResult.nextContinuationToken;
			} while (continuationToken);

			// 4. Gather Local Vault State
			const localFiles: Record<string, { file: TFile; mtime: number; size: number }> = {};
			const allFiles = this.app.vault.getFiles();
			for (const file of allFiles) {
				// Exclude config directory files (e.g. .obsidian/*) and system dotfiles
				if (file.path.startsWith('.') || file.path.includes('/.')) {
					continue;
				}
				localFiles[file.path] = {
					file: file,
					mtime: file.stat.mtime,
					size: file.stat.size,
				};
			}

			// Ensure local cache directory exists
			await this.ensureCacheDirExists();

			// 5. Build combined list of all paths
			const allPaths = new Set([
				...Object.keys(localFiles),
				...Object.keys(remoteFiles),
				...Object.keys(this.syncDb.files || {}),
			]);

			let uploadsCount = 0;
			let downloadsCount = 0;
			let deletesCount = 0;
			let conflictsCount = 0;

			// Initialize syncDb files registry if empty
			if (!this.syncDb.files) {
				this.syncDb.files = {};
			}
			const dbFiles = this.syncDb.files;

			// 6. Iterate and make sync decisions
			for (const path of allPaths) {
				const local = localFiles[path];
				const remote = remoteFiles[path];
				const db = dbFiles[path];

				const isText = path.endsWith('.md') || path.endsWith('.txt');

				// Case 1: Exists in Local, Remote, and DB
				if (local && remote && db) {
					const localChanged = local.mtime !== db.mtime;
					const remoteChanged = remote.etag !== db.etag;

					if (localChanged && remoteChanged) {
						// Conflict!
						conflictsCount++;
						await this.handleConflict(path, local.file, remote.key, s3Client, cryptoKey, isText, remote.etag, remote.lastModified);
					} else if (localChanged) {
						// Local changed only
						uploadsCount++;
						await this.uploadLocalFile(path, local.file, s3Client, cryptoKey);
					} else if (remoteChanged) {
						// Remote changed only
						downloadsCount++;
						await this.downloadRemoteFile(path, remote.key, s3Client, cryptoKey, remote.etag);
					}
				}
				// Case 2: Exists in Local and DB, but NOT Remote (Deleted remotely)
				else if (local && !remote && db) {
					const localChanged = local.mtime !== db.mtime;
					if (localChanged) {
						// Local modified it after remote deleted it. Re-upload.
						uploadsCount++;
						await this.uploadLocalFile(path, local.file, s3Client, cryptoKey);
					} else {
						// Normal deletion from remote. Delete locally.
						deletesCount++;
						await this.app.vault.delete(local.file);
						await this.deleteLocalCache(path);
						delete dbFiles[path];
					}
				}
				// Case 3: Exists in Remote and DB, but NOT Local (Deleted locally)
				else if (!local && remote && db) {
					const remoteChanged = remote.etag !== db.etag;
					if (remoteChanged) {
						// Remote modified it after local deleted it. Re-download.
						downloadsCount++;
						await this.downloadRemoteFile(path, remote.key, s3Client, cryptoKey, remote.etag);
					} else {
						// Normal deletion from local. Delete remotely.
						deletesCount++;
						await s3Client.deleteObject(remote.key);
						await this.deleteLocalCache(path);
						delete dbFiles[path];
					}
				}
				// Case 4: Exists in Local and Remote, but NOT DB (New on both sides, e.g. first sync or sync lost)
				else if (local && remote && !db) {
					// Compare content hashes
					const localData = await this.app.vault.readBinary(local.file);
					const localMd5 = md5(localData);
					
					// ETag is MD5 of compressed + encrypted S3 object if encrypted/compressed, 
					// so we can't easily compare hashes directly unless encryption is disabled.
					let hashesMatch = false;
					if (!this.settings.encrypt && !this.settings.compress) {
						hashesMatch = localMd5 === remote.etag;
					}

					if (hashesMatch) {
						// Identical, just match states
						dbFiles[path] = {
							mtime: local.mtime,
							etag: remote.etag,
							size: local.size,
						};
						await this.writeLocalCache(path, localData);
					} else {
						// Different, treat as conflict
						conflictsCount++;
						await this.handleConflict(path, local.file, remote.key, s3Client, cryptoKey, isText, remote.etag, remote.lastModified);
					}
				}
				// Case 5: Exists in Local only
				else if (local && !remote && !db) {
					uploadsCount++;
					await this.uploadLocalFile(path, local.file, s3Client, cryptoKey);
				}
				// Case 6: Exists in Remote only
				else if (!local && remote && !db) {
					downloadsCount++;
					await this.downloadRemoteFile(path, remote.key, s3Client, cryptoKey, remote.etag);
				}
				// Case 7: Exists in DB only (Deleted on both sides)
				else if (!local && !remote && db) {
					await this.deleteLocalCache(path);
					delete dbFiles[path];
				}
			}

			// 7. Save updated Database
			await this.saveDbCallback(this.syncDb);

			this.updateStatusCallback('Success');
			
			// Show summary notice
			let summaryMsg = 'S3 Sync complete.';
			if (uploadsCount > 0 || downloadsCount > 0 || deletesCount > 0 || conflictsCount > 0) {
				summaryMsg += ` Uploads: ${uploadsCount}, Downloads: ${downloadsCount}, Deletions: ${deletesCount}, Conflicts: ${conflictsCount}`;
			} else {
				summaryMsg += ' Everything is up-to-date.';
			}
			new Notice(summaryMsg);
			console.log(summaryMsg);

		} catch (error: any) {
			console.error('S3 Sync Error:', error);
			this.updateStatusCallback('Error');
			new Notice(`S3 Sync failed: ${error.message}`);
		} finally {
			this.isSyncing = false;
		}
	}

	/**
	 * Upload a local file to S3, encrypting and compressing it if configured.
	 */
	private async uploadLocalFile(
		path: string,
		file: TFile,
		s3Client: S3Client,
		cryptoKey: CryptoKey | null
	): Promise<void> {
		console.log(`Uploading ${path}...`);
		const rawData = await this.app.vault.readBinary(file);
		
		let uploadData = rawData;
		if (this.settings.encrypt && cryptoKey) {
			uploadData = await encryptBuffer(rawData, cryptoKey, this.settings.compress);
		}

		const s3Key = await this.getS3Key(path, cryptoKey);
		const newEtag = await s3Client.putObject(s3Key, uploadData);

		// Update database
		this.syncDb.files[path] = {
			mtime: file.stat.mtime,
			etag: newEtag,
			size: file.stat.size,
		};

		// Write to local cache (plain text)
		await this.writeLocalCache(path, rawData);
	}

	/**
	 * Download a file from S3, decrypting and decompressing it if configured, and save it locally.
	 */
	private async downloadRemoteFile(
		path: string,
		s3Key: string,
		s3Client: S3Client,
		cryptoKey: CryptoKey | null,
		remoteEtag: string
	): Promise<void> {
		console.log(`Downloading ${path}...`);
		const encData = await s3Client.getObject(s3Key);

		let plainData = encData;
		if (this.settings.encrypt && cryptoKey) {
			plainData = await decryptBuffer(encData, cryptoKey, this.settings.compress);
		}

		// Ensure directories exist locally
		await this.ensureLocalFoldersExist(path);

		// Write locally
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.modifyBinary(file, plainData);
		} else {
			await this.app.vault.createBinary(path, plainData);
		}

		// Get local file mtime after writing
		const localFile = this.app.vault.getAbstractFileByPath(path) as TFile;
		
		this.syncDb.files[path] = {
			mtime: localFile.stat.mtime,
			etag: remoteEtag,
			size: localFile.stat.size,
		};

		// Write to local cache (plain text)
		await this.writeLocalCache(path, plainData);
	}

	/**
	 * Handles a conflict when both local and remote files have changed.
	 */
	private async handleConflict(
		path: string,
		localFile: TFile,
		s3Key: string,
		s3Client: S3Client,
		cryptoKey: CryptoKey | null,
		isText: boolean,
		remoteEtag: string,
		remoteLastModified: string
	): Promise<void> {
		console.log(`Conflict detected in ${path}`);

		// 1. Download and decrypt remote content
		const encRemoteData = await s3Client.getObject(s3Key);
		let remoteData = encRemoteData;
		if (this.settings.encrypt && cryptoKey) {
			remoteData = await decryptBuffer(encRemoteData, cryptoKey, this.settings.compress);
		}

		if (isText) {
			// Text file: Run line-by-line 3-way merge
			const localText = await this.app.vault.read(localFile);
			const remoteText = new TextDecoder().decode(remoteData);
			
			// Read base version from cache
			let baseText = '';
			const cachePath = `${this.CACHE_DIR}/${path}`;
			if (await this.app.vault.adapter.exists(cachePath)) {
				baseText = await this.app.vault.adapter.read(cachePath);
			}

			// Split into lines
			const localLines = localText.split('\n');
			const remoteLines = remoteText.split('\n');
			const baseLines = baseText.split('\n');

			// Compare timestamps to find which edit was earlier
			const localMtime = localFile.stat.mtime;
			const remoteMtime = Date.parse(remoteLastModified);
			const localIsEarlier = localMtime < remoteMtime;

			// Perform 3-way merge using diff3Merge
			const mergeChunks = diff3Merge(localLines, baseLines, remoteLines);
			let conflictDetected = false;
			const mergedLines: string[] = [];

			for (const chunk of mergeChunks) {
				if ('ok' in chunk) {
					mergedLines.push(...chunk.ok);
				} else if ('conflict' in chunk) {
					conflictDetected = true;
					const c = chunk.conflict;
					if (localIsEarlier) {
						mergedLines.push(...c.a);
						mergedLines.push(...c.b);
					} else {
						mergedLines.push(...c.b);
						mergedLines.push(...c.a);
					}
				}
			}

			const mergedText = mergedLines.join('\n');
			const mergedBuffer = new TextEncoder().encode(mergedText).buffer;

			// Write merged file locally
			await this.app.vault.modify(localFile, mergedText);

			// Encrypt and upload merged file to S3
			let uploadData = mergedBuffer;
			if (this.settings.encrypt && cryptoKey) {
				uploadData = await encryptBuffer(mergedBuffer, cryptoKey, this.settings.compress);
			}
			const newEtag = await s3Client.putObject(s3Key, uploadData);

			// Update database with merged state
			this.syncDb.files[path] = {
				mtime: localFile.stat.mtime,
				etag: newEtag,
				size: localFile.stat.size,
			};

			// Update cache
			await this.writeLocalCache(path, mergedBuffer);

			if (conflictDetected) {
				new Notice(`S3 Sync: Overlapping changes in ${localFile.name} merged automatically.`);
				console.log(`Overlapping changes in ${path} merged automatically.`);
			} else {
				console.log(`Clean auto-merge succeeded for ${path}`);
			}

		} else {
			// Binary file: Rename local, download remote, upload conflict copy
			const timestamp = new Date().toISOString().replace(/[:-]/g, '').split('.')[0];
			const extIdx = path.lastIndexOf('.');
			const basePathWithoutExt = extIdx !== -1 ? path.substring(0, extIdx) : path;
			const ext = extIdx !== -1 ? path.substring(extIdx) : '';
			
			const cleanDeviceName = this.settings.deviceName.replace(/[^a-zA-Z0-9_-]/g, '');
			const conflictPath = `${basePathWithoutExt}.sync-conflict-${timestamp}-${cleanDeviceName}${ext}`;

			console.log(`Binary conflict: Renaming local to ${conflictPath}`);

			// 1. Save local content as conflict copy
			const localData = await this.app.vault.readBinary(localFile);
			await this.ensureLocalFoldersExist(conflictPath);
			await this.app.vault.createBinary(conflictPath, localData);

			// 2. Upload conflict copy to S3
			const conflictS3Key = await this.getS3Key(conflictPath, cryptoKey);
			let conflictUploadData = localData;
			if (this.settings.encrypt && cryptoKey) {
				conflictUploadData = await encryptBuffer(localData, cryptoKey, this.settings.compress);
			}
			const conflictEtag = await s3Client.putObject(conflictS3Key, conflictUploadData);

			// 3. Overwrite local original file with remote content
			await this.app.vault.modifyBinary(localFile, remoteData);

			// 4. Update DB for conflict file
			const localConflictFile = this.app.vault.getAbstractFileByPath(conflictPath) as TFile;
			this.syncDb.files[conflictPath] = {
				mtime: localConflictFile.stat.mtime,
				etag: conflictEtag,
				size: localConflictFile.stat.size,
			};

			// 5. Update DB for original file
			this.syncDb.files[path] = {
				mtime: localFile.stat.mtime,
				etag: remoteEtag,
				size: localFile.stat.size,
			};

			// Write caches
			await this.writeLocalCache(conflictPath, localData);
			await this.writeLocalCache(path, remoteData);

			new Notice(`S3 Sync: Binary conflict. Saved local copy as ${localConflictFile.name}`);
		}
	}

	/**
	 * Helper to write to local plaintext backup cache inside .obsidian/s3-sync-cache/
	 */
	private async writeLocalCache(path: string, buffer: ArrayBuffer): Promise<void> {
		const cachePath = `${this.CACHE_DIR}/${path}`;
		await this.ensureCacheFoldersExist(cachePath);
		await this.app.vault.adapter.writeBinary(cachePath, buffer);
	}

	/**
	 * Helper to delete local backup cache file.
	 */
	private async deleteLocalCache(path: string): Promise<void> {
		const cachePath = `${this.CACHE_DIR}/${path}`;
		if (await this.app.vault.adapter.exists(cachePath)) {
			await this.app.vault.adapter.remove(cachePath);
		}
	}

	/**
	 * Helper to ensure local vault folders exist for a file.
	 */
	private async ensureLocalFoldersExist(filePath: string): Promise<void> {
		const parts = filePath.split('/');
		parts.pop(); // Remove filename
		if (parts.length === 0) return;

		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const folder = this.app.vault.getAbstractFileByPath(currentPath);
			if (!folder) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}

	/**
	 * Helper to ensure hidden cache folders exist.
	 */
	private async ensureCacheFoldersExist(cachePath: string): Promise<void> {
		const parts = cachePath.split('/');
		parts.pop(); // Remove filename
		if (parts.length === 0) return;

		let currentPath = '';
		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(currentPath))) {
				await this.app.vault.adapter.mkdir(currentPath);
			}
		}
	}

	/**
	 * Ensure the root cache directory exists.
	 */
	private async ensureCacheDirExists(): Promise<void> {
		if (!(await this.app.vault.adapter.exists(this.CACHE_DIR))) {
			await this.app.vault.adapter.mkdir(this.CACHE_DIR);
		}
	}

	/**
	 * Helper to get the S3 key, optionally encrypted.
	 */
	private async getS3Key(path: string, cryptoKey: CryptoKey | null): Promise<string> {
		if (this.settings.encrypt && cryptoKey) {
			const encPath = await encryptPath(path, cryptoKey);
			return pathToS3Key(encPath, this.settings.prefix);
		}
		return pathToS3Key(path, this.settings.prefix);
	}
}
