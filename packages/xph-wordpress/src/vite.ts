import { resolve, sep } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { Plugin, ResolvedConfig } from 'vite';
import { createHtmlTransformMiddleware, createHostRewriteModifier } from 'proxy-html-rewrite';
import { build, createBuilder, type Config } from './build.js';

export interface WordPressOptions extends Omit<Config, 'root' | 'outDir'> {
	/** Existing WordPress theme directory, relative to Vite's root. Required. */
	outDir: string;
	/** WordPress origin to proxy while serving. */
	devProxyTarget?: string;
	/** Skip PHP syntax validation in development and production builds. */
	skipPhpCheck?: boolean;
}

export default function wordpress(options: WordPressOptions): Plugin {
	if (!options?.outDir) throw new Error('xph-wordpress/vite requires an explicit outDir.');
	const upstream = options.devProxyTarget ? new URL(options.devProxyTarget) : undefined;
	let config: ResolvedConfig;
	let cleanup: (() => Promise<void>) | undefined;
	let schedule: ((path: string) => Promise<void>) | undefined;
	let waitForRender: (() => Promise<void>) | undefined;
	let rebuild: ReturnType<typeof createBuilder>;
	const virtual = '\0xph-wordpress-theme';
	const local = (url: string) => /^\/(?:@|__vite|node_modules\/|src\/)/.test(url);
	async function compile(dev: boolean, sourceOnly = false) {
		const buildOptions = { theme: true, skipPhpCheck: options.skipPhpCheck };
		const result = dev
			? await rebuild({ ...buildOptions, dev, sourceOnly })
			: await build({ ...options, root: config.root }, buildOptions);
		const errors = result.diagnostics.filter((d) => d.severity === 'error');
		if (errors.length)
			throw new Error(errors.map((d) => `${d.filename ?? ''}:${d.start}: ${d.message}`).join('\n'));
	}
	return {
		name: 'xph-wordpress',
		config(userConfig) {
			const onwarn = (userConfig.build?.rolldownOptions ?? userConfig.build?.rollupOptions)?.onwarn;
			return {
				publicDir: false,
				appType: 'custom',
				build: {
					outDir: options.outDir,
					emptyOutDir: false,
					copyPublicDir: false,
					rollupOptions: {
						input: virtual,
						onwarn(warning, handler) {
							const callbacks = warning.message.split('\n').filter((line) => /^\s*- /.test(line));
							if (
								warning.code === 'PLUGIN_TIMINGS' &&
								(/Your build spent significant time in plugin [`'"]xph-wordpress[`'"]\./.test(
									warning.message,
								) ||
									(callbacks.length > 0 &&
										callbacks.every((line) => /^\s*- plugin xph-wordpress\s/.test(line))))
							)
								return;
							if (onwarn) onwarn(warning, handler);
							else handler(warning);
						},
					},
				},
				server: upstream
					? {
							proxy: {
								'^/(?!@|__vite|node_modules/|src/)': {
									target: upstream.origin,
									changeOrigin: true,
									autoRewrite: true,
									protocolRewrite: userConfig.server?.https ? 'https' : 'http',
									cookieDomainRewrite: '',
									cookiePathRewrite: '/',
									configure(proxy) {
										proxy.on('proxyReq', (request) => {
											request.removeHeader('accept-encoding');
											request.removeHeader('if-none-match');
											request.removeHeader('if-modified-since');
										});
										proxy.on('proxyRes', (response) => {
											if (!/^text\/html\b/i.test(String(response.headers['content-type']))) return;
											for (const header of [
												'etag',
												'content-md5',
												'digest',
												'last-modified',
												'content-security-policy',
												'content-security-policy-report-only',
											])
												delete response.headers[header];
											response.headers['cache-control'] = 'no-store';
										});
										proxy.on('error', (_error, _request, response) => {
											if ('writeHead' in response && !response.headersSent) {
												response.writeHead(502, { 'Content-Type': 'text/plain' });
												response.end(
													'WordPress is unavailable. Check devProxyTarget and the WordPress server.',
												);
											}
										});
									},
								},
							},
						}
					: undefined,
			};
		},
		configResolved(resolved) {
			config = resolved;
			rebuild = createBuilder({ ...options, root: config.root });
			const out = resolve(config.root, options.outDir);
			const watch = (config.server.watch ??= {});
			const ignored = watch.ignored;
			watch.ignored = [
				...(Array.isArray(ignored) ? ignored : ignored ? [ignored] : []),
				(path: string) => {
					const file = resolve(path);
					return file === out || file.startsWith(out + sep);
				},
			];
		},
		resolveId(id) {
			if (id === virtual) return virtual;
		},
		load(id) {
			if (id === virtual) return 'export {};';
		},
		async closeBundle() {
			await cleanup?.();
		},
		async hotUpdate() {
			await waitForRender?.();
			return [];
		},
		async buildStart() {
			if (config.command === 'build') await compile(false);
		},
		generateBundle(_options, bundle) {
			for (const key of Object.keys(bundle)) delete bundle[key];
		},
		async configureServer(server) {
			if (upstream) {
				const transform = createHtmlTransformMiddleware([
					createHostRewriteModifier(upstream),
					(html) => {
						const client = `<script type="module" src="${config.base}@vite/client"></script>`;
						return /<head\b[^>]*>/i.test(html)
							? html.replace(/<head\b[^>]*>/i, '$&' + client)
							: client + html;
					},
				]);
				server.middlewares.use((req, res, next) =>
					local(req.url ?? '/') ? next() : transform(req, res, next),
				);
			}
			const out = resolve(config.root, options.outDir);
			let closed = false;
			async function run(sourceOnly = false) {
				if (closed) return;
				try {
					await compile(true, sourceOnly);
					if (!closed) server.ws.send({ type: 'full-reload' });
				} catch (e) {
					const message = (e as Error).message;
					server.config.logger.error(message);
					server.ws.send({ type: 'error', err: { message, stack: '' } });
					try {
						await writeFile(resolve(out, 'dev.json'), JSON.stringify({ errors: [message] }));
					} catch (e) {
						if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
					}
				}
			}
			let queue = Promise.resolve();
			let timer: ReturnType<typeof setTimeout>;
			let pending: Promise<void> | undefined;
			waitForRender = async () => {
				// Chokidar emits `all` after its individual file event.
				await Promise.resolve();
				await (pending ?? queue);
			};
			let finish: (() => void) | undefined;
			let sourceOnly = true;
			schedule = (path: string) => {
				const file = resolve(path);
				if (
					file === out ||
					file.startsWith(out + sep) ||
					/(?:^|[/\\])(?:node_modules|\.git|\.xph)(?:[/\\]|$)/.test(file)
				)
					return Promise.resolve();
				if (closed) return Promise.resolve();
				sourceOnly &&= file.endsWith('.xph');
				pending ??= new Promise<void>((resolve) => {
					finish = resolve;
				});
				clearTimeout(timer);
				timer = setTimeout(() => {
					const done = finish!;
					pending = undefined;
					finish = undefined;
					const onlyXph = sourceOnly;
					sourceOnly = true;
					queue = queue.then(() => run(onlyXph)).finally(done);
				}, 100);
				return pending;
			};
			const onChange = (_event: string, path: string) => {
				void schedule?.(path);
			};
			server.watcher.add(config.root);
			server.watcher.on('all', onChange);
			cleanup = async () => {
				closed = true;
				clearTimeout(timer);
				finish?.();
				schedule = undefined;
				waitForRender = undefined;
				server.watcher.off('all', onChange);
				await queue;
			};
			server.watcher.once('close', cleanup);
			server.httpServer?.once('close', cleanup);
			queue = run();
			await queue;
		},
	};
}
