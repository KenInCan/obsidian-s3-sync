import { App, MarkdownView } from 'obsidian';
import { SyncLogStream, LogMessage } from '../utils/logger';
import { ConflictListSuggestModal } from './conflict-modal';
import { PendingConflict } from '../sync';

export interface StatusIndicatorDelegate {
	getPendingConflicts(): PendingConflict[];
	resolveConflict(conflict: PendingConflict, choice: 'local' | 'remote' | 'merge', mergedText?: string): Promise<void>;
	isPathExcluded(path: string): boolean;
}

export class SyncStatusIndicatorManager {
	private app: App;
	private logStream: SyncLogStream;
	private delegate: StatusIndicatorDelegate;
	private statusText = 'Idle';
	private logMessage = '';
	private clearTimer: number | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(app: App, logStream: SyncLogStream, delegate: StatusIndicatorDelegate) {
		this.app = app;
		this.logStream = logStream;
		this.delegate = delegate;

		// Subscribe to logs
		const logHandler = (entry: unknown) => {
			this.handleLog(entry as LogMessage);
		};
		this.logStream.on('log', logHandler);
		this.unsubscribe = () => {
			this.logStream.off('log', logHandler);
		};

		// Initial injection
		this.updateAllIndicators();
	}

	destroy() {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
		if (this.clearTimer !== null) {
			window.clearTimeout(this.clearTimer);
			this.clearTimer = null;
		}
		this.removeAllIndicators();
	}

	setStatus(status: string) {
		this.statusText = status;
		this.updateAllIndicators();
	}

	private handleLog(entry: LogMessage) {
		// Set the latest log message (no timestamp)
		this.logMessage = entry.message;

		// If there was a pending clear timer, clear it
		if (this.clearTimer !== null) {
			window.clearTimeout(this.clearTimer);
			this.clearTimer = null;
		}

		this.updateAllIndicators();

		// If this is a terminal state log, schedule fade-out
		if (
			entry.level === 'success' || 
			entry.level === 'error' || 
			(entry.level === 'warn' && entry.message.includes('S3 Sync complete'))
		) {
			this.clearTimer = window.setTimeout(() => {
				this.logMessage = '';
				this.clearTimer = null;
				this.updateAllIndicators();
			}, 5000);
		}
	}

	public updateAllIndicators() {
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof MarkdownView) {
				this.updateIndicatorForView(view);
			}
		}
	}

	private updateIndicatorForView(view: MarkdownView) {
		const file = view.file;
		const isExcluded = file ? this.delegate.isPathExcluded(file.path) : false;

		const contentEl = view.contentEl;
		let widgetEl = contentEl.querySelector('.s3-sync-status-indicator');

		if (!widgetEl) {
			widgetEl = contentEl.createEl('div', { cls: 's3-sync-status-indicator' });
			widgetEl.createEl('div', { cls: 's3-sync-status-line' });
			widgetEl.createEl('div', { cls: 's3-sync-log-line' });
		}

		const statusEl = widgetEl.querySelector('.s3-sync-status-line') as HTMLElement;
		const logEl = widgetEl.querySelector('.s3-sync-log-line') as HTMLElement;

		const htmlWidget = widgetEl as HTMLElement;

		// 1. Update status line and click handler (always normal status)
		const conflicts = this.delegate.getPendingConflicts();
		if (conflicts.length > 0) {
			htmlWidget.addClass('has-conflicts');
			statusEl.setText(`S3 sync: ${this.statusText} ⚠️`);
			
			htmlWidget.onclick = () => {
				const currentConflicts = this.delegate.getPendingConflicts();
				if (currentConflicts.length > 0) {
					new ConflictListSuggestModal(this.app, currentConflicts, async (conflict, choice, mergedText) => {
						await this.delegate.resolveConflict(conflict, choice, mergedText);
					}).open();
				}
			};
		} else {
			htmlWidget.removeClass('has-conflicts');
			statusEl.setText(`S3 sync: ${this.statusText}`);
			htmlWidget.onclick = null;
		}

		// 2. Handle excluded vs normal state styles and logs
		if (isExcluded) {
			htmlWidget.addClass('is-excluded');
			logEl.setText('File is excluded from S3 sync');
			logEl.removeClass('hidden');
		} else {
			htmlWidget.removeClass('is-excluded');
			if (this.logMessage) {
				logEl.setText(this.logMessage);
				logEl.removeClass('hidden');
			} else {
				logEl.addClass('hidden');
				// Delay text empty slightly for smooth height/opacity transitions in CSS
				window.setTimeout(() => {
					if (!this.logMessage && logEl) {
						logEl.setText('');
					}
				}, 300);
			}
		}
	}

	private removeAllIndicators() {
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof MarkdownView) {
				const widgetEl = view.contentEl.querySelector('.s3-sync-status-indicator');
				if (widgetEl) {
					widgetEl.remove();
				}
			}
		}
	}
}
