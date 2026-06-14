import { Plugin, Notice } from 'obsidian';
import { S3SyncSettingTab, S3SyncSettings, DEFAULT_SETTINGS } from './settings';
import { S3SyncManager, SyncDatabase } from './sync';

export default class S3SyncPlugin extends Plugin {
	settings!: S3SyncSettings;
	syncDb!: SyncDatabase;
	syncManager!: S3SyncManager;

	private statusBarItemEl!: HTMLElement;
	private autoSyncIntervalId: number | null = null;
	private lastSyncTime: string | null = null;

	async onload() {
		// 1. Load configuration and state
		await this.loadPluginData();

		// 2. Generate unique device name if empty
		if (!this.settings.deviceName) {
			const randomId = Math.random().toString(36).substring(2, 6).toUpperCase();
			this.settings.deviceName = `Device-${randomId}`;
			await this.saveSettings();
		}

		// 3. Create status bar item
		this.statusBarItemEl = this.addStatusBarItem();
		this.updateStatusBar('Idle');

		// 4. Initialize Sync Manager
		this.syncManager = new S3SyncManager(
			this.app,
			this.settings,
			this.syncDb,
			async (updatedDb) => {
				this.syncDb = updatedDb;
				await this.savePluginData();
			},
			(status) => this.updateStatusBar(status)
		);

		// 5. Add Ribbon Icon for manual trigger
		const ribbonIconEl = this.addRibbonIcon('cloud-lightning', 'Sync with S3', async (evt: MouseEvent) => {
			await this.syncManager.sync();
		});
		ribbonIconEl.addClass('s3-sync-ribbon-class');

		// 6. Add Command Palette Command
		this.addCommand({
			id: 's3-sync-now',
			name: 'Sync now with S3',
			callback: async () => {
				await this.syncManager.sync();
			},
		});

		// 7. Add Settings Tab
		this.addSettingTab(new S3SyncSettingTab(this.app, this));

		// 8. Setup Auto-Sync interval
		this.setupAutoSync();

		// 9. Sync on Startup (if enabled)
		if (this.settings.syncOnStartup) {
			// Run with a 3-second delay to allow Obsidian layout to settle
			this.app.workspace.onLayoutReady(() => {
				setTimeout(async () => {
					console.log('S3 Sync: Running startup sync...');
					await this.syncManager.sync();
				}, 3000);
			});
		}
	}

	onunload() {
		console.log('Unloading S3 Sync plugin...');
		this.clearAutoSync();
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
		if (!this.statusBarItemEl) return;

		let statusText = 'S3 Sync: ';
		if (status === 'Idle') {
			statusText += this.lastSyncTime ? `Idle (Last: ${this.lastSyncTime})` : 'Idle';
		} else if (status === 'Syncing...') {
			statusText += 'Syncing...';
		} else if (status === 'Success') {
			const now = new Date();
			const hours = String(now.getHours()).padStart(2, '0');
			const minutes = String(now.getMinutes()).padStart(2, '0');
			this.lastSyncTime = `${hours}:${minutes}`;
			statusText += `Success (${this.lastSyncTime})`;
		} else if (status === 'Error') {
			statusText += 'Error ⚠️';
		} else if (status === 'Configuration Error') {
			statusText += 'Setup Required ⚙️';
		} else {
			statusText += status;
		}

		this.statusBarItemEl.setText(statusText);
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
}
