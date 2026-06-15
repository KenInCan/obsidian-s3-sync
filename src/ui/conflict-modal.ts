import { App, Modal, FuzzySuggestModal, Setting } from 'obsidian';
import { PendingConflict } from '../sync';

export class ConflictListSuggestModal extends FuzzySuggestModal<PendingConflict> {
	private conflicts: PendingConflict[];
	private onResolve: (conflict: PendingConflict, choice: 'local' | 'remote' | 'merge') => Promise<void>;

	constructor(
		app: App,
		conflicts: PendingConflict[],
		onResolve: (conflict: PendingConflict, choice: 'local' | 'remote' | 'merge') => Promise<void>
	) {
		super(app);
		this.conflicts = conflicts;
		this.onResolve = onResolve;
		this.setPlaceholder('Select a conflicted file to resolve...');
	}

	getItems(): PendingConflict[] {
		return this.conflicts;
	}

	getItemText(item: PendingConflict): string {
		return item.path;
	}

	onChooseItem(item: PendingConflict, evt: MouseEvent | KeyboardEvent): void {
		const modal = new ConflictResolutionModal(this.app, item, async (choice) => {
			await this.onResolve(item, choice);
			// If there are still pending conflicts, reopen the list
			if (this.conflicts.length > 0) {
				new ConflictListSuggestModal(this.app, this.conflicts, this.onResolve).open();
			}
		});
		modal.open();
	}
}

export class ConflictResolutionModal extends Modal {
	private conflict: PendingConflict;
	private onDecision: (choice: 'local' | 'remote' | 'merge') => Promise<void>;

	constructor(
		app: App,
		conflict: PendingConflict,
		onDecision: (choice: 'local' | 'remote' | 'merge') => Promise<void>
	) {
		super(app);
		this.conflict = conflict;
		this.onDecision = onDecision;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText(`Conflict in: ${this.conflict.path}`);

		const container = contentEl.createDiv({ cls: 's3-sync-conflict-container' });

		// Description
		container.createEl('p', {
			text: 'This file has been modified both locally and remotely. Please review the versions below and choose how to resolve the conflict.',
			cls: 's3-sync-conflict-desc'
		});

		const columns = container.createDiv({ cls: 's3-sync-conflict-columns' });

		// --- LOCAL CARD ---
		const localCard = columns.createDiv({ cls: 's3-sync-conflict-card is-local' });
		localCard.createEl('h4', { text: 'Local Version (Your Device)' });
		
		const localMtime = new Date(this.conflict.localFile.stat.mtime).toLocaleString();
		const localSize = (this.conflict.localFile.stat.size / 1024).toFixed(2);
		localCard.createDiv({ 
			text: `Last Modified: ${localMtime} | Size: ${localSize} KB`,
			cls: 's3-sync-conflict-meta'
		});

		const localPreview = localCard.createDiv({ cls: 's3-sync-conflict-preview' });
		if (this.conflict.isText) {
			const localText = await this.app.vault.read(this.conflict.localFile);
			const lines = localText.split('\n');
			const pre = localPreview.createEl('pre');
			
			console.log('Rendering local preview, conflicts:', this.conflict.conflicts?.localLines);
			let firstConflictEl: HTMLElement | null = null;
			lines.forEach((lineText, idx) => {
				const lineEl = pre.createEl('div', { text: lineText || ' ', cls: 's3-sync-line' });
				if (this.conflict.conflicts?.localLines.includes(idx)) {
					lineEl.classList.add('is-conflicting-line');
					if (!firstConflictEl) firstConflictEl = lineEl;
				}
			});

			if (firstConflictEl) {
				setTimeout(() => {
					firstConflictEl?.scrollIntoView({ block: 'center', inline: 'nearest' });
				}, 150);
			}
		} else {
			localPreview.createEl('div', { text: 'Binary file preview not available.', cls: 's3-sync-conflict-preview-placeholder' });
		}

		// --- REMOTE CARD ---
		const remoteCard = columns.createDiv({ cls: 's3-sync-conflict-card is-remote' });
		remoteCard.createEl('h4', { text: 'Remote Version (S3 Cloud)' });

		const remoteTimeParsed = Date.parse(this.conflict.remoteLastModified);
		const remoteMtime = isNaN(remoteTimeParsed) ? 'Unknown' : new Date(remoteTimeParsed).toLocaleString();
		const remoteSize = (this.conflict.remoteData.byteLength / 1024).toFixed(2);
		remoteCard.createDiv({ 
			text: `Last Modified: ${remoteMtime} | Size: ${remoteSize} KB`,
			cls: 's3-sync-conflict-meta'
		});

		const remotePreview = remoteCard.createDiv({ cls: 's3-sync-conflict-preview' });
		if (this.conflict.isText) {
			const remoteText = new TextDecoder().decode(this.conflict.remoteData);
			const lines = remoteText.split('\n');
			const pre = remotePreview.createEl('pre');

			console.log('Rendering remote preview, conflicts:', this.conflict.conflicts?.remoteLines);
			let firstConflictEl: HTMLElement | null = null;
			lines.forEach((lineText, idx) => {
				const lineEl = pre.createEl('div', { text: lineText || ' ', cls: 's3-sync-line' });
				if (this.conflict.conflicts?.remoteLines.includes(idx)) {
					lineEl.classList.add('is-conflicting-line');
					if (!firstConflictEl) firstConflictEl = lineEl;
				}
			});

			if (firstConflictEl) {
				setTimeout(() => {
					firstConflictEl?.scrollIntoView({ block: 'center', inline: 'nearest' });
				}, 150);
			}
		} else {
			remotePreview.createEl('div', { text: 'Binary file preview not available.', cls: 's3-sync-conflict-preview-placeholder' });
		}

		// --- ACTIONS ---
		const actions = container.createDiv({ cls: 's3-sync-conflict-actions' });

		new Setting(actions)
			.setName('Select Resolution')
			.setDesc('Choose which version to keep.')
			.addButton(btn => btn
				.setButtonText('Keep Local')
				.setCta()
				.onClick(async () => {
					this.close();
					await this.onDecision('local');
				}))
			.addButton(btn => btn
				.setButtonText('Keep Remote')
				.setWarning()
				.onClick(async () => {
					this.close();
					await this.onDecision('remote');
				}));

		if (this.conflict.isText) {
			actions.lastChild?.appendChild(
				new Setting(actions)
					.addButton(btn => btn
						.setButtonText('Auto-Merge (Keep Both)')
						.setClass('s3-sync-merge-btn')
						.onClick(async () => {
							this.close();
							await this.onDecision('merge');
						}))
					.controlEl
			);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
