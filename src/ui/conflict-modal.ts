/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
import { App, Modal, FuzzySuggestModal, ButtonComponent } from 'obsidian';
import { PendingConflict } from '../sync';
// @ts-ignore
import { diff3Merge } from 'node-diff3';

export class ConflictListSuggestModal extends FuzzySuggestModal<PendingConflict> {
	private conflicts: PendingConflict[];
	private onResolve: (conflict: PendingConflict, choice: 'local' | 'remote' | 'merge', mergedText?: string) => Promise<void>;

	constructor(
		app: App,
		conflicts: PendingConflict[],
		onResolve: (conflict: PendingConflict, choice: 'local' | 'remote' | 'merge', mergedText?: string) => Promise<void>
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
		const modal = new ConflictResolutionModal(
			this.app,
			item,
			async (choice, mergedText) => {
				await this.onResolve(item, choice, mergedText);
				// If there are still pending conflicts, reopen the list
				if (this.conflicts.length > 0) {
					new ConflictListSuggestModal(this.app, this.conflicts, this.onResolve).open();
				}
			},
			() => {
				// On Skip: reopen the list suggest modal
				new ConflictListSuggestModal(this.app, this.conflicts, this.onResolve).open();
			}
		);
		modal.open();
	}
}

export class ConflictResolutionModal extends Modal {
	private conflict: PendingConflict;
	private onDecision: (choice: 'local' | 'remote' | 'merge', mergedText?: string) => Promise<void>;
	private onSkip: () => void;
	private decisionMade = false;

	constructor(
		app: App,
		conflict: PendingConflict,
		onDecision: (choice: 'local' | 'remote' | 'merge', mergedText?: string) => Promise<void>,
		onSkip: () => void
	) {
		super(app);
		this.conflict = conflict;
		this.onDecision = onDecision;
		this.onSkip = onSkip;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText(`Conflict in: ${this.conflict.path}`);

		const container = contentEl.createDiv({ cls: 's3-sync-conflict-container' });

		// Description
		container.createEl('p', {
			text: 'This file has been modified both locally and remotely. Click directly on the red conflicting lines in either card to select which version to keep, then confirm merge.',
			cls: 's3-sync-conflict-desc'
		});

		const columns = container.createDiv({ cls: 's3-sync-conflict-columns' });

		// Read and diff files first to establish mappings
		let localLines: string[] = [];
		let remoteLines: string[] = [];
		let mergeChunks: any[] = [];
		let localIsEarlier = true;
		let remoteMtimeNum = 0;

		interface DisplayLine {
			text: string;
			isConflict: boolean;
			blockId?: number;
			slotOffset?: number;
			isPlaceholder: boolean;
		}

		const localDisplayLines: DisplayLine[] = [];
		const remoteDisplayLines: DisplayLine[] = [];
		let totalSlots = 0;
		let totalBlocks = 0;
		const blockSlotCounts: Record<number, number> = {};

		if (this.conflict.isText) {
			const localText = await this.app.vault.read(this.conflict.localFile);
			const remoteText = new TextDecoder().decode(this.conflict.remoteData);
			localLines = localText.split('\n');
			remoteLines = remoteText.split('\n');

			let baseText = '';
			const cacheDir = `${this.app.vault.configDir}/s3-sync-cache`;
			const cachePath = `${cacheDir}/${this.conflict.path}`;
			if (await this.app.vault.adapter.exists(cachePath)) {
				baseText = await this.app.vault.adapter.read(cachePath);
			}
			const baseLines = baseText.split('\n');

			const localMtime = this.conflict.localFile.stat.mtime;
			const remoteTimeParsed = Date.parse(this.conflict.remoteLastModified);
			remoteMtimeNum = isNaN(remoteTimeParsed) ? localMtime : remoteTimeParsed;
			localIsEarlier = localMtime < remoteMtimeNum;

			mergeChunks = diff3Merge(localLines, baseLines, remoteLines);

			let blockId = 0;
			for (const chunk of mergeChunks) {
				if ('ok' in chunk) {
					for (const line of chunk.ok) {
						localDisplayLines.push({ text: line, isConflict: false, isPlaceholder: false });
						remoteDisplayLines.push({ text: line, isConflict: false, isPlaceholder: false });
					}
				} else if ('conflict' in chunk) {
					const c = chunk.conflict;
					const isInsertOnly = c.o.every((line: string) => isBlankLine(line));
					if (isInsertOnly) {
						const maxLen = Math.max(c.a.length, c.b.length);
						for (let i = 0; i < maxLen; i++) {
							const localLine = i < c.a.length ? c.a[i] : null;
							const remoteLine = i < c.b.length ? c.b[i] : null;
							localDisplayLines.push({
								text: localLine !== null ? localLine : '',
								isConflict: false,
								isPlaceholder: localLine === null
							});
							remoteDisplayLines.push({
								text: remoteLine !== null ? remoteLine : '',
								isConflict: false,
								isPlaceholder: remoteLine === null
							});
						}
					} else {
						const maxLen = Math.max(c.a.length, c.b.length);
						for (let i = 0; i < maxLen; i++) {
							const localLine = i < c.a.length ? c.a[i] : null;
							const remoteLine = i < c.b.length ? c.b[i] : null;

							localDisplayLines.push({
								text: localLine !== null ? localLine : '',
								isConflict: true,
								blockId: blockId,
								slotOffset: i,
								isPlaceholder: localLine === null
							});

							remoteDisplayLines.push({
								text: remoteLine !== null ? remoteLine : '',
								isConflict: true,
								blockId: blockId,
								slotOffset: i,
								isPlaceholder: remoteLine === null
							});
						}
						totalSlots += maxLen;
						blockSlotCounts[blockId] = maxLen;
						blockId++;
					}
				}
			}
			totalBlocks = blockId;
		}

		const lineChoices: Record<string, 'local' | 'remote'> = {};
		let confirmMergeBtn: ButtonComponent | null = null;

		const updateLineStyles = () => {
			const lines = container.querySelectorAll('.s3-sync-line[data-block-id][data-slot-offset]');
			lines.forEach((el) => {
				const line = el as HTMLElement;
				const bid = parseInt(line.dataset.blockId || '', 10);
				const slot = parseInt(line.dataset.slotOffset || '', 10);
				const side = line.dataset.lineSide;
				const key = `${bid}_${slot}`;
				const choice = lineChoices[key];

				line.classList.remove('is-selected-conflict-line');
				line.classList.remove('is-deselected-conflict-line');

				if (choice !== undefined) {
					if (side === choice) {
						line.classList.add('is-selected-conflict-line');
					} else {
						line.classList.add('is-deselected-conflict-line');
					}
				}
			});

			const allResolved = Object.keys(lineChoices).length === totalSlots;
			if (confirmMergeBtn) {
				confirmMergeBtn.setDisabled(!allResolved);
			}
		};

		// --- LOCAL CARD ---
		const localCard = columns.createDiv({ cls: 's3-sync-conflict-card is-local' });
		localCard.createEl('h4', { text: 'Local version (your device)' });
		
		const localMtime = new Date(this.conflict.localFile.stat.mtime).toLocaleString();
		const localSize = (this.conflict.localFile.stat.size / 1024).toFixed(2);
		localCard.createDiv({ 
			text: `Last modified: ${localMtime} | Size: ${localSize} KB`,
			cls: 's3-sync-conflict-meta'
		});

		const localPreview = localCard.createDiv({ cls: 's3-sync-conflict-preview' });
		if (this.conflict.isText) {
			const pre = localPreview.createEl('pre');
			let firstConflictEl: HTMLElement | null = null;
			localDisplayLines.forEach((item) => {
				const lineEl = pre.createEl('div', { text: item.text || ' ', cls: 's3-sync-line' });
				if (item.isConflict) {
					lineEl.classList.add('is-conflicting-line');
					if (item.isPlaceholder) {
						lineEl.classList.add('is-placeholder-line');
					}
					lineEl.dataset.blockId = String(item.blockId);
					lineEl.dataset.slotOffset = String(item.slotOffset);
					lineEl.dataset.lineSide = 'local';
					lineEl.addEventListener('click', () => {
						const key = `${item.blockId}_${item.slotOffset}`;
						lineChoices[key] = 'local';
						updateLineStyles();
					});
					if (!firstConflictEl) firstConflictEl = lineEl;
				}
			});

			if (firstConflictEl) {
				window.setTimeout(() => {
					firstConflictEl?.scrollIntoView({ block: 'center', inline: 'nearest' });
				}, 150);
			}
		} else {
			localPreview.createEl('div', { text: 'Binary file preview not available.', cls: 's3-sync-conflict-preview-placeholder' });
		}

		const localBtnContainer = localCard.createDiv({ cls: 's3-sync-conflict-card-action' });
		new ButtonComponent(localBtnContainer)
			.setButtonText('Keep local')
			.setCta()
			.onClick(async () => {
				if (this.conflict.isText && totalSlots > 0) {
					for (let bid = 0; bid < totalBlocks; bid++) {
						const maxLen = blockSlotCounts[bid];
						for (let i = 0; i < maxLen; i++) {
							lineChoices[`${bid}_${i}`] = 'local';
						}
					}
					updateLineStyles();
				} else {
					this.decisionMade = true;
					this.close();
					await this.onDecision('local');
				}
			});

		// --- REMOTE CARD ---
		const remoteCard = columns.createDiv({ cls: 's3-sync-conflict-card is-remote' });
		remoteCard.createEl('h4', { text: 'Remote version (S3 cloud)' });

		const remoteTimeParsed = Date.parse(this.conflict.remoteLastModified);
		const remoteMtime = isNaN(remoteTimeParsed) ? 'Unknown' : new Date(remoteTimeParsed).toLocaleString();
		const remoteSize = (this.conflict.remoteData.byteLength / 1024).toFixed(2);
		remoteCard.createDiv({ 
			text: `Last modified: ${remoteMtime} | Size: ${remoteSize} KB`,
			cls: 's3-sync-conflict-meta'
		});

		const remotePreview = remoteCard.createDiv({ cls: 's3-sync-conflict-preview' });
		if (this.conflict.isText) {
			const pre = remotePreview.createEl('pre');
			let firstConflictEl: HTMLElement | null = null;
			remoteDisplayLines.forEach((item) => {
				const lineEl = pre.createEl('div', { text: item.text || ' ', cls: 's3-sync-line' });
				if (item.isConflict) {
					lineEl.classList.add('is-conflicting-line');
					if (item.isPlaceholder) {
						lineEl.classList.add('is-placeholder-line');
					}
					lineEl.dataset.blockId = String(item.blockId);
					lineEl.dataset.slotOffset = String(item.slotOffset);
					lineEl.dataset.lineSide = 'remote';
					lineEl.addEventListener('click', () => {
						const key = `${item.blockId}_${item.slotOffset}`;
						lineChoices[key] = 'remote';
						updateLineStyles();
					});
					if (!firstConflictEl) firstConflictEl = lineEl;
				}
			});

			if (firstConflictEl) {
				window.setTimeout(() => {
					firstConflictEl?.scrollIntoView({ block: 'center', inline: 'nearest' });
				}, 150);
			}
		} else {
			remotePreview.createEl('div', { text: 'Binary file preview not available.', cls: 's3-sync-conflict-preview-placeholder' });
		}

		// Keep Remote button (under remote card)
		const remoteBtnContainer = remoteCard.createDiv({ cls: 's3-sync-conflict-card-action' });
		const remoteBtn = new ButtonComponent(remoteBtnContainer)
			.setButtonText('Keep remote')
			.onClick(async () => {
				if (this.conflict.isText && totalSlots > 0) {
					for (let bid = 0; bid < totalBlocks; bid++) {
						const maxLen = blockSlotCounts[bid];
						for (let i = 0; i < maxLen; i++) {
							lineChoices[`${bid}_${i}`] = 'remote';
						}
					}
					updateLineStyles();
				} else {
					this.decisionMade = true;
					this.close();
					await this.onDecision('remote');
				}
			});
		remoteBtn.buttonEl.classList.add('s3-sync-btn-warning');

		// --- ACTIONS FOOTER ---
		const footer = container.createDiv({ cls: 's3-sync-conflict-actions-footer' });

		// Dedicated Skip button on the left
		new ButtonComponent(footer)
			.setButtonText('Skip')
			.onClick(() => {
				this.close();
			});

		// Confirm button on the left next to Skip (if text and has conflict blocks)
		if (this.conflict.isText && totalSlots > 0) {
			const mergeBtnComponent = new ButtonComponent(footer)
				.setButtonText('Confirm')
				.setDisabled(true)
				.onClick(async () => {
					this.decisionMade = true;
					this.close();

					// Build final merged lines
					const finalMergedLines: string[] = [];
					let activeConflictIdx = 0;

					for (const chunk of mergeChunks) {
						if ('ok' in chunk) {
							finalMergedLines.push(...chunk.ok);
						} else if ('conflict' in chunk) {
							const c = chunk.conflict;
							const isInsertOnly = c.o.every((line: string) => isBlankLine(line));
							if (isInsertOnly) {
								if (localIsEarlier) {
									finalMergedLines.push(...c.a);
									finalMergedLines.push(...c.b);
								} else {
									finalMergedLines.push(...c.b);
									finalMergedLines.push(...c.a);
								}
							} else {
								const maxLen = Math.max(c.a.length, c.b.length);
								for (let i = 0; i < maxLen; i++) {
									const choice = lineChoices[`${activeConflictIdx}_${i}`];
									if (choice === 'local') {
										if (i < c.a.length) {
											finalMergedLines.push(c.a[i]);
										}
									} else if (choice === 'remote') {
										if (i < c.b.length) {
											finalMergedLines.push(c.b[i]);
										}
									}
								}
								activeConflictIdx++;
							}
						}
					}

					await this.onDecision('merge', finalMergedLines.join('\n'));
				});
			mergeBtnComponent.buttonEl.classList.add('s3-sync-merge-btn');
			confirmMergeBtn = mergeBtnComponent;
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		if (!this.decisionMade) {
			this.onSkip();
		}
	}
}

function isBlankLine(line: string): boolean {
	if (!line) return true;
	const trimmed = line.replace(/\r/g, '').trim();
	return trimmed === '';
}
