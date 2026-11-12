import { styleText } from 'node:util';

type Format = Parameters<typeof styleText>[0];
export type Level = 'info' | 'warn' | 'error';

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	/** Dimmed text for secondary details such as paths. */
	dim(text: string): string;
	/** Highlighted text for names and URLs. */
	bold(text: string): string;
}

/** Vite-style logs: a dimmed time, a colored tag, then the message. Colors follow NO_COLOR and TTY detection. */
export function createLogger(tag = 'xph'): Logger {
	const color = (format: Format, text: string, stream: NodeJS.WriteStream) =>
		styleText(format, text, { stream });
	const write = (level: Level, message: string) => {
		const stream = level === 'info' ? process.stdout : process.stderr;
		const time = new Date().toLocaleTimeString();
		const format: Format = level === 'error' ? 'red' : level === 'warn' ? 'yellow' : 'cyan';
		const body = level === 'info' ? message : color(format, message, stream);
		stream.write(
			`${color('dim', time, stream)} ${color(['bold', format], `[${tag}]`, stream)} ${body}\n`,
		);
	};
	return {
		info: (message) => write('info', message),
		warn: (message) => write('warn', message),
		error: (message) => write('error', message),
		dim: (text) => styleText('dim', text, { stream: process.stdout }),
		bold: (text) => styleText('bold', text, { stream: process.stdout }),
	};
}
