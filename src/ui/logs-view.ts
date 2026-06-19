import { ItemView, WorkspaceLeaf } from 'obsidian';
import { SyncLogStream, LogMessage } from '../utils/logger';

export const VIEW_TYPE_SYNC_LOGS = 's3-sync-logs-view';

export class SyncLogsView extends ItemView {
	private logStream: SyncLogStream;
	private logContainerEl!: HTMLElement;
	private autoScroll = true;
	private unsubscribe: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, logStream: SyncLogStream) {
		super(leaf);
		this.logStream = logStream;
	}

	getViewType(): string {
		return VIEW_TYPE_SYNC_LOGS;
	}

	getDisplayText(): string {
		return 'S3 sync logs';
	}

	getIcon(): string {
		return 'file-text';
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('s3-sync-logs-view-container');

		// Create Header/Toolbar
		const headerEl = container.createEl('div', { cls: 's3-sync-logs-header' });
		
		// Add Title/Prompt badge
		headerEl.createEl('div', { cls: 's3-sync-logs-title', text: 'S3 sync log stream' });

		// Add Actions container
		const actionsEl = headerEl.createEl('div', { cls: 's3-sync-logs-actions' });

		// Auto-scroll toggle wrapper
		const toggleLabel = actionsEl.createEl('label', { cls: 's3-sync-logs-toggle-label' });
		const toggleCheckbox = toggleLabel.createEl('input', { type: 'checkbox' });
		toggleCheckbox.checked = this.autoScroll;
		toggleLabel.createSpan({ text: 'Auto-scroll' });

		toggleCheckbox.addEventListener('change', () => {
			this.autoScroll = toggleCheckbox.checked;
			if (this.autoScroll) {
				this.scrollToBottom();
			}
		});

		// Clear button
		const clearBtn = actionsEl.createEl('button', { 
			cls: 's3-sync-logs-btn', 
			text: 'Clear' 
		});
		clearBtn.addEventListener('click', () => {
			this.logStream.clear();
		});

		// Create Log Lines terminal container
		this.logContainerEl = container.createEl('div', { cls: 's3-sync-logs-terminal' });

		// Add current log list
		this.renderLogs();

		// Subscribe to log stream events
		const logHandler = (entry: unknown) => {
			this.appendLog(entry as LogMessage);
		};
		const clearHandler = () => {
			this.logContainerEl.empty();
		};

		this.logStream.on('log', logHandler);
		this.logStream.on('clear', clearHandler);

		this.unsubscribe = () => {
			this.logStream.off('log', logHandler);
			this.logStream.off('clear', clearHandler);
		};
	}

	async onClose() {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}
	}

	private renderLogs() {
		this.logContainerEl.empty();
		const logs = this.logStream.getLogs();
		for (const entry of logs) {
			this.appendLog(entry, false);
		}
		this.scrollToBottom();
	}

	private appendLog(entry: LogMessage, shouldScroll = true) {
		const logLine = this.logContainerEl.createEl('div', { 
			cls: `s3-sync-logs-line log-level-${entry.level}` 
		});
		
		logLine.createEl('span', { cls: 's3-sync-logs-time', text: `[${entry.timestamp}] ` });
		logLine.createEl('span', { cls: 's3-sync-logs-msg', text: entry.message });

		if (this.autoScroll && shouldScroll) {
			this.scrollToBottom();
		}
	}

	private scrollToBottom() {
		this.logContainerEl.scrollTop = this.logContainerEl.scrollHeight;
	}
}
