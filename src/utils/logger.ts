import { Events } from 'obsidian';

export interface LogMessage {
	timestamp: string;
	level: 'info' | 'warn' | 'error' | 'success';
	message: string;
}

export class SyncLogStream extends Events {
	private logs: LogMessage[] = [];
	private maxLogs = 1000;

	log(level: 'info' | 'warn' | 'error' | 'success', message: string) {
		const now = new Date();
		const hours = String(now.getHours()).padStart(2, '0');
		const minutes = String(now.getMinutes()).padStart(2, '0');
		const seconds = String(now.getSeconds()).padStart(2, '0');
		const timestamp = `${hours}:${minutes}:${seconds}`;

		const entry: LogMessage = {
			timestamp,
			level,
			message
		};

		this.logs.push(entry);
		if (this.logs.length > this.maxLogs) {
			this.logs.shift();
		}

		this.trigger('log', entry);
	}

	getLogs(): LogMessage[] {
		return this.logs;
	}

	clear() {
		this.logs = [];
		this.trigger('clear');
	}
}
