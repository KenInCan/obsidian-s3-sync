/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, obsidianmd/rule-custom-message, @typescript-eslint/no-misused-promises */
import { Plugin, Notice } from 'obsidian';
import { S3SyncSettingTab, S3SyncSettings, DEFAULT_SETTINGS } from './settings';
import { S3SyncManager, SyncDatabase } from './sync';
import { ConflictListSuggestModal } from './ui/conflict-modal';
import { SyncLogStream } from './utils/logger';
import { SyncLogsView, VIEW_TYPE_SYNC_LOGS } from './ui/logs-view';
import { SyncStatusIndicatorManager } from './ui/status-indicator';
import { isPathExcluded } from './utils';

export default class S3SyncPlugin extends Plugin {
	settings!: S3SyncSettings;
	syncDb!: SyncDatabase;
	syncManager!: S3SyncManager;
	logStream!: SyncLogStream;

	statusIndicatorManager!: SyncStatusIndicatorManager;
	private autoSyncIntervalId: number | null = null;
	private lastSyncTime: string | null = null;

	async onload() {
		// 1. Load configuration and state
		await this.loadPluginData();

		// Instantiate the log stream
		this.logStream = new SyncLogStream();

		// Register logs view
		this.registerView(
			VIEW_TYPE_SYNC_LOGS,
			(leaf) => new SyncLogsView(leaf, this.logStream)
		);

		// 2. Generate unique device name if empty
		if (!this.settings.deviceName) {
			const randomId = Math.random().toString(36).substring(2, 6).toUpperCase();
			this.settings.deviceName = `Device-${randomId}`;
			await this.saveSettings();
		}

		// 4. Initialize Sync Manager
		this.syncManager = new S3SyncManager(
			this.app,
			this.settings,
			this.syncDb,
			async (updatedDb) => {
				this.syncDb = updatedDb;
				await this.savePluginData();
			},
			(status) => this.updateStatusBar(status),
			(conflicts, isManual) => {
				if (isManual) {
					new ConflictListSuggestModal(this.app, conflicts, async (conflict, choice) => {
						await this.syncManager.resolveConflict(conflict, choice);
					}).open();
				} else {
					new Notice(`S3 Sync: ${conflicts.length} conflict(s) detected. Click the top-right status indicator to resolve.`);
				}
			},
			this.logStream
		);

		// 3. Initialize Status Indicator Manager (Top Right)
		this.statusIndicatorManager = new SyncStatusIndicatorManager(this.app, this.logStream, {
			getPendingConflicts: () => this.syncManager ? this.syncManager.pendingConflicts : [],
			resolveConflict: async (conflict, choice) => {
				await this.syncManager.resolveConflict(conflict, choice);
			},
			isPathExcluded: (path) => isPathExcluded(path, this.settings.excludedPaths)
		});
		this.updateStatusBar('Idle');

		// Register workspace listeners for the status indicator
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				if (this.statusIndicatorManager) {
					this.statusIndicatorManager.updateAllIndicators();
				}
			})
		);
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				if (this.statusIndicatorManager) {
					this.statusIndicatorManager.updateAllIndicators();
				}
			})
		);

		// 5. Add Ribbon Icon for manual trigger
		const ribbonIconEl = this.addRibbonIcon('cloud-lightning', 'Sync with S3', async (evt: MouseEvent) => {
			await this.syncManager.sync(true);
		});
		ribbonIconEl.addClass('s3-sync-ribbon-class');

		// Add Ribbon Icon for Log Stream
		this.addRibbonIcon('file-text', 'S3 sync logs', () => {
			void this.activateView();
		});

		// 6. Add Command Palette Commands
		this.addCommand({
			id: 's3-sync-now',
			name: 'Sync now with S3',
			callback: async () => {
				await this.syncManager.sync(true);
			},
		});

		this.addCommand({
			id: 's3-sync-show-logs',
			name: 'Show logs',
			callback: () => {
				void this.activateView();
			}
		});

		this.addCommand({
			id: 's3-sync-resolve-conflicts',
			name: 'Resolve sync conflicts',
			checkCallback: (checking: boolean): boolean => {
				const hasConflicts = this.syncManager && this.syncManager.pendingConflicts.length > 0;
				if (checking) {
					return hasConflicts;
				}
				if (hasConflicts) {
					new ConflictListSuggestModal(this.app, this.syncManager.pendingConflicts, async (conflict, choice) => {
						await this.syncManager.resolveConflict(conflict, choice);
					}).open();
				}
				return true;
			}
		});

		// 7. Add Settings Tab
		this.addSettingTab(new S3SyncSettingTab(this.app, this));

		// 8. Setup Auto-Sync interval
		this.setupAutoSync();

		// 9. Sync on Startup (if enabled)
		if (this.settings.syncOnStartup) {
			// Run with a 3-second delay to allow Obsidian layout to settle
			this.app.workspace.onLayoutReady(() => {
				window.setTimeout(() => {
					console.log('S3 Sync: Running startup sync...');
					this.syncManager.sync().catch(err => {
						console.error(err);
					});
				}, 3000);
			});
		}
	}

	onunload() {
		console.log('Unloading S3 Sync plugin...');
		this.clearAutoSync();
		if (this.statusIndicatorManager) {
			this.statusIndicatorManager.destroy();
		}
	}

	/**
	 * Configures or re-schedules the auto-sync interval.
	 */
	setupAutoSync() {
		this.clearAutoSync();

		const intervalMinutes = this.settings.autoSyncInterval;
		if (intervalMinutes > 0) {
			console.log(`S3 Sync: Scheduling auto-sync every ${intervalMinutes} minutes.`);
			
			const intervalId = window.setInterval(async () => {
				if (this.syncManager) {
					await this.syncManager.sync();
				}
			}, intervalMinutes * 60 * 1000);
			
			this.autoSyncIntervalId = intervalId;
			this.registerInterval(intervalId);
		}
	}

	private clearAutoSync() {
		if (this.autoSyncIntervalId !== null) {
			window.clearInterval(this.autoSyncIntervalId);
			this.autoSyncIntervalId = null;
		}
	}

	/**
	 * Updates the status bar UI.
	 */
	updateStatusBar(status: string) {
		let statusText = '';
		if (status === 'Idle') {
			statusText = this.lastSyncTime ? `Idle (Last: ${this.lastSyncTime})` : 'Idle';
		} else if (status === 'Syncing...') {
			statusText = 'Syncing...';
		} else if (status === 'Success') {
			const now = new Date();
			const hours = String(now.getHours()).padStart(2, '0');
			const minutes = String(now.getMinutes()).padStart(2, '0');
			this.lastSyncTime = `${hours}:${minutes}`;
			statusText = `Success (${this.lastSyncTime})`;
		} else if (status === 'Error') {
			statusText = 'Error ⚠️';
		} else if (status === 'Configuration Error') {
			statusText = 'Setup Required ⚙️';
		} else {
			statusText = status;
		}

		if (this.statusIndicatorManager) {
			this.statusIndicatorManager.setStatus(statusText);
		}
	}

	/**
	 * Save only settings.
	 */
	async saveSettings() {
		await this.savePluginData();
	}

	/**
	 * Load settings and sync database state from data.json.
	 */
	private async loadPluginData() {
		const data = await this.loadData() || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
		this.syncDb = data.syncDb || { files: {} };
	}

	/**
	 * Save settings and sync database state to data.json.
	 */
	private async savePluginData() {
		await this.saveData({
			settings: this.settings,
			syncDb: this.syncDb
		});
	}

	async activateView() {
		const { workspace } = this.app;
		
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_SYNC_LOGS)[0];
		if (!leaf) {
			leaf = workspace.getLeaf('tab');
			await leaf.setViewState({
				type: VIEW_TYPE_SYNC_LOGS,
				active: true,
			});
		}
		await workspace.revealLeaf(leaf);
	}
}
