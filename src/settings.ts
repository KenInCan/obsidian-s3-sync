/* eslint-disable obsidianmd/settings-tab/no-manual-html-headings, obsidianmd/ui/sentence-case, obsidianmd/no-static-styles-assignment, @typescript-eslint/no-deprecated, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import S3SyncPlugin from './main';
import { S3Client } from './s3';

export interface S3SyncSettings {
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
	autoSyncInterval: number; // In minutes, 0 means disabled
	syncOnStartup: boolean;
	syncOnFileOpen: boolean;
	syncOnTabSwitch: boolean;
	excludedPaths: string;
}

export const DEFAULT_SETTINGS: S3SyncSettings = {
	endpointUrl: '',
	region: 'us-east-1',
	bucket: '',
	accessKeyId: '',
	secretAccessKey: '',
	prefix: '',
	deviceName: '',
	encrypt: false,
	passphrase: '',
	compress: true,
	autoSyncInterval: 0,
	syncOnStartup: false,
	syncOnFileOpen: false,
	syncOnTabSwitch: false,
	excludedPaths: ''
};

export class S3SyncSettingTab extends PluginSettingTab {
	plugin: S3SyncPlugin;

	constructor(app: App, plugin: S3SyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'S3 Sync Settings' });

		// --- SECTION: S3 CREDENTIALS ---
		containerEl.createEl('h3', { text: 'S3 Connection Credentials' });

		new Setting(containerEl)
			.setName('Endpoint URL')
			.setDesc('Leave blank for standard AWS S3. For Cloudflare R2, Backblaze B2, or MinIO, enter the custom endpoint (e.g. https://<id>.r2.cloudflarestorage.com).')
			.addText(text => text
				.setPlaceholder('https://example.com')
				.setValue(this.plugin.settings.endpointUrl)
				.onChange(async (value) => {
					this.plugin.settings.endpointUrl = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Region')
			.setDesc('AWS S3 region (e.g., us-east-1, auto).')
			.addText(text => text
				.setPlaceholder('us-east-1')
				.setValue(this.plugin.settings.region)
				.onChange(async (value) => {
					this.plugin.settings.region = value.trim() || 'us-east-1';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Bucket Name')
			.setDesc('The name of your S3 bucket.')
			.addText(text => text
				.setPlaceholder('my-obsidian-vault')
				.setValue(this.plugin.settings.bucket)
				.onChange(async (value) => {
					this.plugin.settings.bucket = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Access Key ID')
			.setDesc('AWS Access Key ID.')
			.addText(text => text
				.setPlaceholder('AKIA...')
				.setValue(this.plugin.settings.accessKeyId)
				.onChange(async (value) => {
					this.plugin.settings.accessKeyId = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Secret Access Key')
			.setDesc('AWS Secret Access Key.')
			.addText(text => {
				text.inputEl.type = 'password';
				text.setPlaceholder('Secret Key')
					.setValue(this.plugin.settings.secretAccessKey)
					.onChange(async (value) => {
						this.plugin.settings.secretAccessKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('S3 Folder Prefix')
			.setDesc('Optional directory prefix inside the bucket (e.g. obsidian-vault/).')
			.addText(text => text
				.setPlaceholder('vault/')
				.setValue(this.plugin.settings.prefix)
				.onChange(async (value) => {
					this.plugin.settings.prefix = value.trim();
					await this.plugin.saveSettings();
				}));

		// TEST CONNECTION BUTTON
		new Setting(containerEl)
			.setName('Test S3 Connection')
			.setDesc('Validate credentials and bucket accessibility.')
			.addButton(button => button
				.setButtonText('Test Connection')
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Testing...');
					
					try {
						if (!this.plugin.settings.bucket || !this.plugin.settings.accessKeyId || !this.plugin.settings.secretAccessKey) {
							throw new Error('Please fill in Bucket Name, Access Key, and Secret Key.');
						}

						const s3Client = new S3Client({
							endpointUrl: this.plugin.settings.endpointUrl,
							region: this.plugin.settings.region || 'us-east-1',
							bucket: this.plugin.settings.bucket,
							accessKeyId: this.plugin.settings.accessKeyId,
							secretAccessKey: this.plugin.settings.secretAccessKey,
						});

						// Attempt to list objects with prefix (limited test)
						await s3Client.listObjects(this.plugin.settings.prefix);
						new Notice('S3 Sync: Connection successful!');
					} catch (err: any) {
						new Notice(`S3 Sync: Connection failed. ${err.message}`);
					} finally {
						button.setDisabled(false);
						button.setButtonText('Test Connection');
					}
				}));

		// --- SECTION: SYNC OPTIONS ---
		containerEl.createEl('h3', { text: 'Sync Settings' });

		new Setting(containerEl)
			.setName('Device Name')
			.setDesc('Unique identifier for this device to prevent conflict filename clashes.')
			.addText(text => text
				.setPlaceholder('My Laptop')
				.setValue(this.plugin.settings.deviceName)
				.onChange(async (value) => {
					this.plugin.settings.deviceName = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync on Startup')
			.setDesc('Automatically trigger a sync when Obsidian starts up.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync on file open')
			.setDesc('Automatically trigger a sync when a note or file is opened.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnFileOpen)
				.onChange(async (value) => {
					this.plugin.settings.syncOnFileOpen = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync on tab switch')
			.setDesc('Automatically trigger a sync when switching editor tabs.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnTabSwitch)
				.onChange(async (value) => {
					this.plugin.settings.syncOnTabSwitch = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto-Sync Interval')
			.setDesc('How often to run sync automatically. Select "Disabled" to only sync manually.')
			.addDropdown(dropdown => dropdown
				.addOption('0', 'Disabled')
				.addOption('5', 'Every 5 minutes')
				.addOption('15', 'Every 15 minutes')
				.addOption('30', 'Every 30 minutes')
				.addOption('60', 'Every hour')
				.setValue(String(this.plugin.settings.autoSyncInterval))
				.onChange(async (value) => {
					this.plugin.settings.autoSyncInterval = parseInt(value, 10);
					await this.plugin.saveSettings();
					this.plugin.setupAutoSync(); // Reschedule auto sync
				}));

		new Setting(containerEl)
			.setName('Excluded Paths')
			.setDesc('Line-separated list of paths (folders or files, relative to vault root) to exclude from sync. E.g. "Private/" or "secret.md".')
			.addTextArea(text => {
				text.inputEl.rows = 4;
				text.inputEl.style.width = '100%';
				text.setPlaceholder('Private/\nsecret.md\n# comments are supported')
					.setValue(this.plugin.settings.excludedPaths)
					.onChange(async (value) => {
						this.plugin.settings.excludedPaths = value;
						await this.plugin.saveSettings();
					});
			});

		// --- SECTION: SECURITY & COMPRESSION ---
		containerEl.createEl('h3', { text: 'Security & Optimization' });

		new Setting(containerEl)
			.setName('Client-Side Encryption (Zero-Knowledge)')
			.setDesc('Encrypt all file contents locally using AES-GCM-256 before uploading to S3. Requires a passphrase.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.encrypt)
				.onChange(async (value) => {
					this.plugin.settings.encrypt = value;
					await this.plugin.saveSettings();
					this.display(); // Redraw to show/hide passphrase setting
				}));

		if (this.plugin.settings.encrypt) {
			new Setting(containerEl)
				.setName('Encryption Passphrase')
				.setDesc('Shared passphrase to encrypt/decrypt files. MUST be identical on all synced devices.')
				.addText(text => {
					text.inputEl.type = 'password';
					text.setPlaceholder('Enter passphrase')
						.setValue(this.plugin.settings.passphrase)
						.onChange(async (value) => {
							this.plugin.settings.passphrase = value.trim();
							await this.plugin.saveSettings();
						});
				});
		}

		new Setting(containerEl)
			.setName('Compress Files (Gzip)')
			.setDesc('Compress file contents natively using Gzip before uploading. Reduces size by 60-80% for text.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.compress)
				.onChange(async (value) => {
					this.plugin.settings.compress = value;
					await this.plugin.saveSettings();
				}));
	}
}
