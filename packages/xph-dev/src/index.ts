import { createServer, type ServerResponse } from 'node:http';
import { relative, resolve, sep } from 'node:path';
import { watch } from 'chokidar';
import { client } from './client.js';
import { createLogger, type Logger } from './logger.js';

export { createLogger, type Logger, type Level } from './logger.js';

export interface BuildContext {
	/** Only .xph files changed since the last build, so other inputs can be reused. */
	sourceOnly: boolean;
	/** Absolute paths changed since the last build; empty for the initial build. */
	changed: string[];
	/** URL of the live reload script to load on every page in development. */
	client: string;
	/**
	 * Also watch files the build read outside `paths`, such as imported modules. Report them even
	 * when the build fails; after a successful build, files it no longer reported are unwatched.
	 */
	watch(files: Iterable<string>): void;
}

export interface DevOptions {
	/** Project directory; changed paths are logged relative to it. */
	root: string;
	/** Files and directories to watch. Defaults to the project directory. */
	paths?: string[];
	/** Paths that never trigger a rebuild, such as the output directory. */
	ignore?: (path: string) => boolean;
	/** Live reload server port. Defaults to a free port. */
	port?: number;
	/**
	 * Build once, then after each batch of changes. Throw to report a failure and keep the last good output.
	 * Return 'styles' when only stylesheets changed, or 'reload' when the page did; by default only a batch
	 * of .css files updates styles in place.
	 */
	build(context: BuildContext): Promise<Update | void>;
	/** Called with the message of each failed build, after it is logged. */
	onError?(message: string): void | Promise<void>;
	logger?: Logger;
}

/** How open pages pick up a successful build. */
export type Update = 'styles' | 'reload';

export interface DevServer {
	/** URL of the live reload script. */
	client: string;
	/** Resolves once pending changes are built. */
	settled(): Promise<void>;
	close(): Promise<void>;
}

const excluded = /(?:^|[/\\])(?:node_modules|\.git|\.xph)(?:[/\\]|$)/;
// Editors write backups, swap files and Vim's 4913 write probe next to the file being saved.
const scratch = /(?:~|\.sw[nop]|[/\\]4913|[/\\]\.#[^/\\]*)$/;

/** Watch a project, rebuild it one batch at a time, and reload connected browsers. */
export async function dev(options: DevOptions): Promise<DevServer> {
	const root = resolve(options.root);
	const logger = options.logger ?? createLogger();
	const names = (files: string[]) =>
		logger.dim(files.map((file) => relative(root, file)).join(', '));
	const clients = new Set<ServerResponse>();
	let failure: string | undefined;
	const send = (event: string, data: unknown = null) => {
		for (const response of clients)
			response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};
	const server = createServer((request, response) => {
		const path = new URL(request.url ?? '/', 'http://localhost').pathname;
		// Pages load the client from the runtime's own origin.
		response.setHeader('Access-Control-Allow-Origin', '*');
		if (path === '/client.js') {
			response.writeHead(200, {
				'Content-Type': 'text/javascript',
				'Cache-Control': 'no-store',
			});
			response.end(client);
		} else if (path === '/events') {
			response.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-store',
				Connection: 'keep-alive',
			});
			response.write(
				failure === undefined
					? ': connected\n\n'
					: `event: failed\ndata: ${JSON.stringify(failure)}\n\n`,
			);
			clients.add(response);
			request.once('close', () => clients.delete(response));
		} else {
			response.writeHead(404).end();
		}
	});
	await new Promise<void>((done, fail) => {
		server.once('error', fail);
		server.listen(options.port ?? 0, '127.0.0.1', () => {
			server.off('error', fail);
			done();
		});
	});
	const { port } = server.address() as { port: number };
	const url = `http://127.0.0.1:${port}/client.js`;

	let closed = false;
	const watched = (options.paths ?? [root]).map((path) => resolve(root, path));
	const inputs = new Set<string>();
	/** Watch the files a build reported; a successful build also drops the ones it no longer read. */
	function track(files: Set<string>, complete: boolean) {
		if (closed) return;
		const wanted = new Set(
			[...files].filter(
				(file) => !ignored(file) && !watched.some((directory) => inside(directory, file)),
			),
		);
		const added = [...wanted].filter((file) => !inputs.has(file));
		const removed = complete ? [...inputs].filter((file) => !wanted.has(file)) : [];
		for (const file of added) inputs.add(file);
		for (const file of removed) inputs.delete(file);
		if (added.length) watcher.add(added);
		if (removed.length) watcher.unwatch(removed);
	}
	async function run(changed: string[]) {
		if (closed) return;
		const sourceOnly = changed.length > 0 && changed.every((file) => file.endsWith('.xph'));
		const read = new Set<string>();
		const watch = (files: Iterable<string>) => {
			for (const file of files) read.add(resolve(root, file));
		};
		try {
			const update =
				(await options.build({ sourceOnly, changed, client: url, watch })) ??
				(changed.every((file) => file.endsWith('.css')) ? 'styles' : 'reload');
			track(read, true);
			if (closed) return;
			const recovered = failure !== undefined;
			failure = undefined;
			// Stylesheets swap in place; anything else may change the page itself.
			if (!recovered && changed.length > 0 && update === 'styles') {
				send('styles');
				logger.info(`${logger.bold('css update')} ${names(changed)}`);
			} else {
				send('ok');
				send('reload');
				if (changed.length) logger.info(`${logger.bold('page reload')} ${names(changed)}`);
			}
		} catch (e) {
			track(read, false);
			failure = (e as Error).message;
			send('failed', failure);
			logger.error(failure);
			await options.onError?.(failure);
		}
	}

	let queue = Promise.resolve();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: Promise<void> | undefined;
	let finish: (() => void) | undefined;
	const changed = new Set<string>();
	const ignored = (path: string) => {
		const file = resolve(path);
		return excluded.test(file) || scratch.test(file) || options.ignore?.(file) === true;
	};
	const watcher = watch(watched, {
		ignoreInitial: true,
		followSymlinks: false,
		ignored,
	});
	watcher.on('all', (_event, path) => {
		if (closed || ignored(path)) return;
		changed.add(resolve(path));
		pending ??= new Promise<void>((done) => {
			finish = done;
		});
		clearTimeout(timer);
		timer = setTimeout(() => {
			const done = finish!;
			const batch = [...changed];
			changed.clear();
			pending = undefined;
			finish = undefined;
			queue = queue.then(() => run(batch)).finally(done);
		}, 100);
	});
	await new Promise<void>((done) => watcher.once('ready', done));
	queue = run([]);
	await queue;
	logger.info(`watching for changes ${logger.dim('— live reload at')} ${logger.bold(url)}`);
	return {
		client: url,
		async settled() {
			// Chokidar may still be delivering events for a write that just finished.
			await Promise.resolve();
			await (pending ?? queue);
			await queue;
		},
		async close() {
			closed = true;
			clearTimeout(timer);
			finish?.();
			await watcher.close();
			for (const response of clients) response.end();
			await new Promise<void>((done) => server.close(() => done()));
			await queue;
		},
	};
}

/** Whether `path` is `directory` or inside it. */
export function inside(directory: string, path: string): boolean {
	return path === directory || path.startsWith(directory + sep);
}
