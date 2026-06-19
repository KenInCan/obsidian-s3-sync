/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, obsidianmd/rule-custom-message, obsidianmd/prefer-file-manager-trash-file, obsidianmd/no-tfile-tfolder-cast, obsidianmd/ui/sentence-case, @typescript-eslint/no-explicit-any */
import { App, Notice, TFile } from 'obsidian';
// @ts-ignore
import { diff3Merge } from 'node-diff3';
import { S3Client } from './s3';
import { deriveKey, encryptBuffer, decryptBuffer, encryptPath, decryptPath } from './crypto';
import { pathToS3Key, s3KeyToPath, md5, isPathExcluded } from './utils';
import { SyncLogStream } from './utils/logger';

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
	syncOnFileOpen: boolean;
	syncOnTabSwitch: boolean;
	conflictStrategy: 'ask' | 'local' | 'remote';
	excludedPaths: string;
}

export interface FileSyncState {
	mtime: number;
	etag: string;
	size: number;
}

export interface SyncDatabase {
	files: Record<string, FileSyncState>;
}

export interface PendingConflict {
	path: string;
	localFile: TFile;
	s3Key: string;
	remoteData: ArrayBuffer;
	remoteEtag: string;
	remoteLastModified: string;
	isText: boolean;
	conflicts?: {
		localLines: number[];
		remoteLines: number[];
	};
}

function isBlankLine(line: string): boolean {
	if (!line) return true;
	const trimmed = line.replace(/\r/g, '').trim();
	return trimmed === '';
}

export class S3SyncManager {
	private app: App;
	private settings: SyncSettings;
	private syncDb: SyncDatabase;
	private saveDbCallback: (db: SyncDatabase) => Promise<void>;
	private updateStatusCallback: (status: string) => void;
	private onConflictsDetected?: (conflicts: PendingConflict[], isManual: boolean) => void;
	private logStream: SyncLogStream;
	
	private isSyncing = false;
	get cacheDir(): string {
		return `${this.app.vault.configDir}/s3-sync-cache`;
	}
	public pendingConflicts: PendingConflict[] = [];

	constructor(
		app: App,
		settings: SyncSettings,
		syncDb: SyncDatabase,
		saveDbCallback: (db: SyncDatabase) => Promise<void>,
		updateStatusCallback: (status: string) => void,
		onConflictsDetected?: (conflicts: PendingConflict[], isManual: boolean) => void,
		logStream?: SyncLogStream
	) {
		this.app = app;
		this.settings = settings;
		this.syncDb = syncDb;
		this.saveDbCallback = saveDbCallback;
		this.updateStatusCallback = updateStatusCallback;
		this.onConflictsDetected = onConflictsDetected;
		this.logStream = logStream || new SyncLogStream();
	}

	/**
	 * Run the synchronization cycle.
	 */
	async sync(isManual = false): Promise<void> {
		if (this.isSyncing) {
			this.logStream.log('warn', 'S3 Sync already in progress, skipping...');
			return;
		}

		// Validate credentials first
		if (!this.settings.bucket || !this.settings.accessKeyId || !this.settings.secretAccessKey) {
			this.updateStatusCallback('Configuration Error');
			this.logStream.log('error', 'Sync configuration is missing. Setup S3 credentials in settings first.');
			return;
		}

		this.isSyncing = true;
		this.updateStatusCallback('Syncing...');
		this.logStream.log('info', 'Starting S3 sync cycle...');
		new Notice('S3 Sync: Starting sync...');
		
		// Reset pending conflicts for this run
		this.pendingConflicts = [];

		try {
			// 1. Derive Key if encryption is enabled
			let cryptoKey: CryptoKey | null = null;
			if (this.settings.encrypt) {
				if (!this.settings.passphrase) {
					throw new Error('Encryption is enabled but no passphrase is set.');
				}
				this.logStream.log('info', 'Deriving encryption key...');
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
			this.logStream.log('info', 'Listing remote S3 objects...');
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
								this.logStream.log('warn', `Failed to decrypt remote path '${path}', skipping.`);
								continue;
							}
						}
						if (isPathExcluded(path, this.settings.excludedPaths)) {
							continue;
						}
						remoteFiles[path] = { etag: obj.etag, size: obj.size, key: obj.key, lastModified: obj.lastModified };
					}
				}
				continuationToken = listResult.nextContinuationToken;
			} while (continuationToken);

			// 4. Gather Local Vault State
			this.logStream.log('info', 'Gathering local file states...');
			const localFiles: Record<string, { file: TFile; mtime: number; size: number }> = {};
			const allFiles = this.app.vault.getFiles();
			for (const file of allFiles) {
				// Exclude config directory files (e.g. .obsidian/*) and system dotfiles
				if (file.path.startsWith('.') || file.path.includes('/.')) {
					continue;
				}
				if (isPathExcluded(file.path, this.settings.excludedPaths)) {
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

			// Initialize syncDb files registry if empty
			if (!this.syncDb.files) {
				this.syncDb.files = {};
			}
			const dbFiles = this.syncDb.files;

			// Define planning interface
			interface SyncPlanItem {
				path: string;
				action: 'upload' | 'download' | 'deleteLocal' | 'deleteRemote' | 'conflict' | 'dbMatchOnly' | 'deleteDbOnly';
				local?: typeof localFiles[string];
				remote?: typeof remoteFiles[string];
				db?: typeof dbFiles[string];
				isText?: boolean;
			}

			// Planning Phase
			this.logStream.log('info', 'Comparing local and remote file states to build sync plan...');
			const plan: SyncPlanItem[] = [];

			for (const path of allPaths) {
				if (isPathExcluded(path, this.settings.excludedPaths)) {
					continue;
				}
				const local = localFiles[path];
				const remote = remoteFiles[path];
				const db = dbFiles[path];
				const isText = path.endsWith('.md') || path.endsWith('.txt');

				if (local && remote && db) {
					const localChanged = local.mtime !== db.mtime;
					const remoteChanged = remote.etag !== db.etag;

					if (localChanged && remoteChanged) {
						plan.push({ path, action: 'conflict', local, remote, db, isText });
					} else if (localChanged) {
						plan.push({ path, action: 'upload', local, remote, db });
					} else if (remoteChanged) {
						plan.push({ path, action: 'download', local, remote, db });
					}
				} else if (local && !remote && db) {
					const localChanged = local.mtime !== db.mtime;
					if (localChanged) {
						plan.push({ path, action: 'upload', local, remote, db });
					} else {
						plan.push({ path, action: 'deleteLocal', local, remote, db });
					}
				} else if (!local && remote && db) {
					const remoteChanged = remote.etag !== db.etag;
					if (remoteChanged) {
						plan.push({ path, action: 'download', local, remote, db });
					} else {
						plan.push({ path, action: 'deleteRemote', local, remote, db });
					}
				} else if (local && remote && !db) {
					const localData = await this.app.vault.readBinary(local.file);
					const localMd5 = md5(localData);
					let hashesMatch = false;
					if (!this.settings.encrypt && !this.settings.compress) {
						hashesMatch = localMd5 === remote.etag;
					}

					if (hashesMatch) {
						plan.push({ path, action: 'dbMatchOnly', local, remote, db });
					} else {
						plan.push({ path, action: 'conflict', local, remote, db, isText });
					}
				} else if (local && !remote && !db) {
					plan.push({ path, action: 'upload', local, remote, db });
				} else if (!local && remote && !db) {
					plan.push({ path, action: 'download', local, remote, db });
				} else if (!local && !remote && db) {
					plan.push({ path, action: 'deleteDbOnly', local, remote, db });
				}
			}

			// Filter actions that perform actual sync transfers or conflicts
			const syncActions = plan.filter(item => ['upload', 'download', 'deleteLocal', 'deleteRemote', 'conflict'].includes(item.action));
			const totalToSync = syncActions.length;

			this.logStream.log('info', `Sync plan built. Total files to sync: ${totalToSync}`);

			let uploadsCount = 0;
			let downloadsCount = 0;
			let deletesCount = 0;
			let conflictsCount = 0;
			let processedCount = 0;

			// Execution Phase
			for (const item of plan) {
				const { path, action, local, remote, isText } = item;

				if (action === 'dbMatchOnly') {
					dbFiles[path] = {
						mtime: local!.mtime,
						etag: remote!.etag,
						size: local!.size,
					};
					const localData = await this.app.vault.readBinary(local!.file);
					await this.writeLocalCache(path, localData);
					continue;
				}

				if (action === 'deleteDbOnly') {
					await this.deleteLocalCache(path);
					delete dbFiles[path];
					continue;
				}

				processedCount++;
				const progressPrefix = `[${processedCount}/${totalToSync}]`;

				if (action === 'upload') {
					this.logStream.log('info', `${progressPrefix} Uploading: ${path}`);
					try {
						await this.uploadLocalFile(path, local!.file, s3Client, cryptoKey);
						uploadsCount++;
						this.logStream.log('success', `${progressPrefix} Upload completed: ${path}`);
					} catch (err: any) {
						this.logStream.log('error', `${progressPrefix} Upload failed for ${path}: ${err.message}`);
						throw err;
					}
				} else if (action === 'download') {
					this.logStream.log('info', `${progressPrefix} Downloading: ${path}`);
					try {
						await this.downloadRemoteFile(path, remote!.key, s3Client, cryptoKey, remote!.etag);
						downloadsCount++;
						this.logStream.log('success', `${progressPrefix} Download completed: ${path}`);
					} catch (err: any) {
						this.logStream.log('error', `${progressPrefix} Download failed for ${path}: ${err.message}`);
						throw err;
					}
				} else if (action === 'deleteLocal') {
					this.logStream.log('info', `${progressPrefix} Deleting local file: ${path}`);
					try {
						await this.app.vault.delete(local!.file);
						await this.deleteLocalCache(path);
						delete dbFiles[path];
						deletesCount++;
						this.logStream.log('success', `${progressPrefix} Deleted local file: ${path}`);
					} catch (err: any) {
						this.logStream.log('error', `${progressPrefix} Local deletion failed for ${path}: ${err.message}`);
						throw err;
					}
				} else if (action === 'deleteRemote') {
					this.logStream.log('info', `${progressPrefix} Deleting remote S3 object: ${path}`);
					try {
						await s3Client.deleteObject(remote!.key);
						await this.deleteLocalCache(path);
						delete dbFiles[path];
						deletesCount++;
						this.logStream.log('success', `${progressPrefix} Deleted remote object: ${path}`);
					} catch (err: any) {
						this.logStream.log('error', `${progressPrefix} Remote deletion failed for ${path}: ${err.message}`);
						throw err;
					}
				} else if (action === 'conflict') {
					this.logStream.log('warn', `${progressPrefix} Sync conflict: ${path}`);
					try {
						const queued = await this.handleConflict(path, local!.file, remote!.key, s3Client, cryptoKey, !!isText, remote!.etag, remote!.lastModified);
						if (queued) {
							conflictsCount++;
							this.logStream.log('warn', `${progressPrefix} Conflict queued for resolution: ${path}`);
						} else {
							this.logStream.log('success', `${progressPrefix} Conflict auto-merged: ${path}`);
						}
					} catch (err: any) {
						this.logStream.log('error', `${progressPrefix} Conflict resolution setup failed for ${path}: ${err.message}`);
						throw err;
					}
				}
			}

			// 7. Save updated Database
			await this.saveDbCallback(this.syncDb);

			if (this.pendingConflicts.length > 0) {
				this.updateStatusCallback(`Conflict (${this.pendingConflicts.length})`);
			} else {
				this.updateStatusCallback('Success');
			}
			
			// Show summary notice
			let summaryMsg = 'S3 Sync complete.';
			if (uploadsCount > 0 || downloadsCount > 0 || deletesCount > 0 || conflictsCount > 0) {
				summaryMsg += ` Uploads: ${uploadsCount}, Downloads: ${downloadsCount}, Deletions: ${deletesCount}, Conflicts: ${conflictsCount}`;
			} else {
				summaryMsg += ' Everything is up-to-date.';
			}
			new Notice(summaryMsg);
			
			this.logStream.log(this.pendingConflicts.length > 0 ? 'warn' : 'success', summaryMsg);

			// Trigger callback if conflicts are found
			if (this.pendingConflicts.length > 0 && this.onConflictsDetected) {
				this.onConflictsDetected(this.pendingConflicts, isManual);
			}

		} catch (error: any) {
			console.error('S3 Sync Error:', error);
			this.updateStatusCallback('Error');
			this.logStream.log('error', `Sync failed: ${error.message}`);
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
			uploadData = await encryptBuffer(rawData, cryptoKey, this.settings.compress, file.stat.mtime);
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
			const res = await decryptBuffer(encData, cryptoKey, this.settings.compress);
			plainData = res.decrypted;
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
	 * Handles a conflict by classifying insert vs update, auto-merging inserts and queueing updates.
	 * Returns true if the conflict was queued for manual resolution, false if auto-resolved.
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
	): Promise<boolean> {
		if (this.settings.conflictStrategy === 'local') {
			this.logStream.log('info', `Conflict resolution strategy is 'Keep local', auto-resolving ${path}`);
			await this.uploadLocalFile(path, localFile, s3Client, cryptoKey);
			return false;
		} else if (this.settings.conflictStrategy === 'remote') {
			this.logStream.log('info', `Conflict resolution strategy is 'Keep remote', auto-resolving ${path}`);
			await this.downloadRemoteFile(path, s3Key, s3Client, cryptoKey, remoteEtag);
			return false;
		}

		console.log(`Conflict detected in ${path}`);

		// 1. Download and decrypt remote content
		const encRemoteData = await s3Client.getObject(s3Key);
		let remoteData = encRemoteData;
		let remoteEditMtime = Date.parse(remoteLastModified);
		if (this.settings.encrypt && cryptoKey) {
			const res = await decryptBuffer(encRemoteData, cryptoKey, this.settings.compress);
			remoteData = res.decrypted;
			if (res.mtime !== undefined) {
				remoteEditMtime = res.mtime;
			}
		}

		if (isText) {
			// Text file: Run line-by-line 3-way merge
			const localText = await this.app.vault.read(localFile);
			const remoteText = new TextDecoder().decode(remoteData);
			
			// Read base version from cache
			let baseText = '';
			const cachePath = `${this.cacheDir}/${path}`;
			if (await this.app.vault.adapter.exists(cachePath)) {
				baseText = await this.app.vault.adapter.read(cachePath);
			}

			// Split into lines
			const localLines = localText.split('\n');
			const remoteLines = remoteText.split('\n');
			const baseLines = baseText.split('\n');

			// Compare timestamps to find which edit was earlier
			const localMtime = localFile.stat.mtime;
			const remoteMtime = remoteEditMtime;
			const localIsEarlier = localMtime < remoteMtime;

			// Perform 3-way merge using diff3Merge
			const mergeChunks = diff3Merge(localLines, baseLines, remoteLines);
			let updateConflictDetected = false;
			let insertConflictDetected = false;
			const localConflictLines: number[] = [];
			const remoteConflictLines: number[] = [];
			const mergedLines: string[] = [];

			for (const chunk of mergeChunks) {
				if ('ok' in chunk) {
					mergedLines.push(...chunk.ok);
				} else if ('conflict' in chunk) {
					const c = chunk.conflict;
					const isInsertOnly = c.o.every((line: string) => isBlankLine(line));

					if (isInsertOnly) {
						insertConflictDetected = true;
						if (localIsEarlier) {
							mergedLines.push(...c.a);
							mergedLines.push(...c.b);
						} else {
							mergedLines.push(...c.b);
							mergedLines.push(...c.a);
						}
					} else {
						updateConflictDetected = true;
						for (let i = 0; i < c.a.length; i++) {
							localConflictLines.push(c.aIndex + i);
						}
						for (let i = 0; i < c.b.length; i++) {
							remoteConflictLines.push(c.bIndex + i);
						}
					}
				}
			}

			if (updateConflictDetected) {
				// Queue it as an update conflict
				console.log(`Update conflict queued for text file ${path}`);
				this.pendingConflicts.push({
					path,
					localFile,
					s3Key,
					remoteData,
					remoteEtag,
					remoteLastModified,
					isText: true,
					conflicts: {
						localLines: localConflictLines,
						remoteLines: remoteConflictLines
					}
				});
				return true;
			} else {
				// Pure insertion conflict or no conflict (or clean merge)
				const mergedText = mergedLines.join('\n');
				const mergedBuffer = new TextEncoder().encode(mergedText).buffer;

				// Write merged file locally
				await this.app.vault.modify(localFile, mergedText);

				// Encrypt and upload merged file to S3
				let uploadData = mergedBuffer;
				if (this.settings.encrypt && cryptoKey) {
					uploadData = await encryptBuffer(mergedBuffer, cryptoKey, this.settings.compress, localFile.stat.mtime);
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

				if (insertConflictDetected) {
					new Notice(`S3 Sync: Insertions in ${localFile.name} merged automatically.`);
					console.log(`Insertions in ${path} merged automatically.`);
				} else {
					console.log(`Clean auto-merge succeeded for ${path}`);
				}
				return false;
			}
		} else {
			// Binary file: Queue it as a conflict
			console.log(`Binary conflict queued for ${path}`);
			this.pendingConflicts.push({
				path,
				localFile,
				s3Key,
				remoteData,
				remoteEtag,
				remoteLastModified,
				isText: false
			});
			return true;
		}
	}

	/**
	 * Resolve a pending conflict with the user's choice.
	 */
	async resolveConflict(
		conflict: PendingConflict,
		choice: 'local' | 'remote' | 'merge',
		mergedText?: string
	): Promise<void> {
		const { path, localFile, s3Key, remoteData, remoteEtag } = conflict;
		this.logStream.log('info', `Resolving conflict for ${path} using choice: ${choice}`);

		// Instantiate clients & key
		const s3Client = new S3Client({
			endpointUrl: this.settings.endpointUrl,
			region: this.settings.region || 'us-east-1',
			bucket: this.settings.bucket,
			accessKeyId: this.settings.accessKeyId,
			secretAccessKey: this.settings.secretAccessKey,
		});

		let cryptoKey: CryptoKey | null = null;
		if (this.settings.encrypt) {
			cryptoKey = await deriveKey(this.settings.passphrase, this.settings.bucket);
		}

		try {
			if (choice === 'local') {
				// Keep local: upload local to S3
				await this.uploadLocalFile(path, localFile, s3Client, cryptoKey);
				this.logStream.log('success', `Conflict resolved: Kept local version for ${path}`);
				new Notice(`Conflict resolved: Kept local version for ${localFile.name}`);
			} else if (choice === 'remote') {
				// Keep remote: download remote to local
				await this.downloadRemoteFile(path, s3Key, s3Client, cryptoKey, remoteEtag);
				this.logStream.log('success', `Conflict resolved: Kept remote version for ${path}`);
				new Notice(`Conflict resolved: Kept remote version for ${localFile.name}`);
			} else if (choice === 'merge') {
				// Merge: only applicable for text
				if (!conflict.isText) return;

				let finalMergedText = mergedText;
				if (finalMergedText === undefined) {
					const localText = await this.app.vault.read(localFile);
					const remoteText = new TextDecoder().decode(remoteData);
					
					let baseText = '';
					const cachePath = `${this.cacheDir}/${path}`;
					if (await this.app.vault.adapter.exists(cachePath)) {
						baseText = await this.app.vault.adapter.read(cachePath);
					}

					const localLines = localText.split('\n');
					const remoteLines = remoteText.split('\n');
					const baseLines = baseText.split('\n');

					const localMtime = localFile.stat.mtime;
					const remoteMtime = Date.parse(conflict.remoteLastModified);
					const localIsEarlier = isNaN(remoteMtime) ? true : localMtime < remoteMtime;

					const mergeChunks = diff3Merge(localLines, baseLines, remoteLines);
					const mergedLines: string[] = [];

					for (const chunk of mergeChunks) {
						if ('ok' in chunk) {
							mergedLines.push(...chunk.ok);
						} else if ('conflict' in chunk) {
							const c = chunk.conflict;
							// Force stack both versions (since user chose to merge)
							if (localIsEarlier) {
								mergedLines.push(...c.a);
								mergedLines.push(...c.b);
							} else {
								mergedLines.push(...c.b);
								mergedLines.push(...c.a);
							}
						}
					}
					finalMergedText = mergedLines.join('\n');
				}

				const mergedBuffer = new TextEncoder().encode(finalMergedText).buffer;

				// Write merged locally
				await this.app.vault.modify(localFile, finalMergedText);

				// Get the updated file reference to retrieve the new mtime and size from the vault
				const updatedLocalFile = this.app.vault.getAbstractFileByPath(path) as TFile;

				// Upload to S3
				let uploadData = mergedBuffer;
				if (this.settings.encrypt && cryptoKey) {
					uploadData = await encryptBuffer(mergedBuffer, cryptoKey, this.settings.compress, updatedLocalFile.stat.mtime);
				}
				const newEtag = await s3Client.putObject(s3Key, uploadData);

				// Update db
				this.syncDb.files[path] = {
					mtime: updatedLocalFile.stat.mtime,
					etag: newEtag,
					size: updatedLocalFile.stat.size,
				};

				// Update cache
				await this.writeLocalCache(path, mergedBuffer);

				this.logStream.log('success', `Conflict resolved: Merged both versions for ${path}`);
				new Notice(`Conflict resolved: Merged both versions for ${localFile.name}`);
			}
		} catch (err: any) {
			this.logStream.log('error', `Conflict resolution failed for ${path}: ${err.message}`);
			throw err;
		}

		// Remove from pending list in-place
		const conflictIdx = this.pendingConflicts.findIndex(c => c.path === path);
		if (conflictIdx !== -1) {
			this.pendingConflicts.splice(conflictIdx, 1);
		}

		// Save updated db
		await this.saveDbCallback(this.syncDb);

		// Update status bar depending on remaining conflicts
		if (this.pendingConflicts.length > 0) {
			this.updateStatusCallback(`Conflict (${this.pendingConflicts.length})`);
		} else {
			this.updateStatusCallback('Success');
		}
	}

	/**
	 * Helper to write to local plaintext backup cache inside .obsidian/s3-sync-cache/
	 */
	private async writeLocalCache(path: string, buffer: ArrayBuffer): Promise<void> {
		const cachePath = `${this.cacheDir}/${path}`;
		await this.ensureCacheFoldersExist(cachePath);
		await this.app.vault.adapter.writeBinary(cachePath, buffer);
	}

	/**
	 * Helper to delete local backup cache file.
	 */
	private async deleteLocalCache(path: string): Promise<void> {
		const cachePath = `${this.cacheDir}/${path}`;
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
		if (!(await this.app.vault.adapter.exists(this.cacheDir))) {
			await this.app.vault.adapter.mkdir(this.cacheDir);
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

