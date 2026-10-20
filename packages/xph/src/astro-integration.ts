import { readFile } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.js';
import { position } from './source.js';
import { emitPhpPages } from './astro-pages.js';

export interface AstroOptions {
	/** Additional component entries relative to Astro's root. Imports are discovered automatically. */
	entries?: string[];
	/** Directory owned by xph inside Astro's output. Defaults to `xph`. */
	directory?: string;
	/** Override the public URL for generated assets, e.g. a CDN URL. */
	assetBase?: string;
}

interface Logger {
	info(message: string): void;
	error(message: string): void;
}
interface AstroConfig {
	root: URL;
	outDir: URL;
	cacheDir: URL;
	base: string;
	output?: string;
}
interface DevServer {
	middlewares: {
		use(
			handler: (
				request: { url?: string; method?: string },
				response: {
					setHeader(name: string, value: string): unknown;
					end(body?: Uint8Array): unknown;
				},
				next: (error?: unknown) => void,
			) => void,
		): unknown;
	};
	watcher: {
		add(paths: string | readonly string[]): unknown;
		on(event: 'all', listener: (event: string, path: string) => void): unknown;
		off(event: 'all', listener: (event: string, path: string) => void): unknown;
	};
	httpServer: { once(event: 'close', listener: () => void): unknown } | null;
	ws: { send(payload: { type: 'full-reload'; path: string }): unknown };
}

/**
 * A structural AstroIntegration: importing this entry does not require Astro at runtime.
 * PHP stays request-time code; this integration does not execute it inside Astro's JS renderer.
 */
export default function xph(options: AstroOptions = {}) {
	if (
		options.entries !== undefined &&
		(!Array.isArray(options.entries) ||
			options.entries.some((entry) => typeof entry !== 'string' || !entry.endsWith('.xph')))
	) {
		throw new Error('xph/astro requires an entries array of .xph component paths.');
	}
	const entries = [...(options.entries ?? [])];
	const directory = options.directory ?? 'xph';
	// A namespace is necessary: xph owns its components/assets directories, while Astro owns its output.
	if (
		!directory ||
		!/^[a-zA-Z0-9._/-]+$/.test(directory) ||
		directory.includes('\\') ||
		directory.split('/').some((part) => !part || part === '.' || part === '..') ||
		directory.startsWith('/') ||
		/^[a-z]:/i.test(directory)
	) {
		throw new Error(
			'xph/astro directory must be a relative output subdirectory without dot segments.',
		);
	}
	let config: AstroConfig | undefined;
	let queue = Promise.resolve();
	let devDir: string | undefined;
	let generated = false;
	const dependencies = new Set<string>();
	const assetBase = () =>
		options.assetBase ?? `${(config!.base || '/').replace(/\/$/, '')}/${directory}/assets/`;
	const contains = (parent: string, file: string) => {
		const path = relative(parent, file);
		return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path));
	};
	async function compile(outDir: string, logger: Logger) {
		if (!config) throw new Error('xph/astro has not received the resolved Astro configuration.');
		const result = await build({
			root: fileURLToPath(config.root),
			entries,
			outDir,
			assetBase: assetBase(),
		});
		dependencies.clear();
		for (const file of result.components.keys()) dependencies.add(file);
		if (result.diagnostics.some((d) => d.severity === 'error')) {
			const messages = await Promise.all(
				result.diagnostics.map(async (d) => {
					const file = d.filename ?? '';
					const source = file ? await readFile(file, 'utf8') : '';
					const pos = position(source, d.start);
					return `${file}:${pos.line + 1}:${pos.character + 1}: ${d.message}`;
				}),
			);
			throw new Error('xph compilation failed:\n' + messages.join('\n'));
		}
		logger.info(`Compiled ${result.components.size} PHP components to ${outDir}`);
		return result;
	}
	return {
		name: 'xph',
		hooks: {
			'astro:config:setup': ({
				addRenderer,
				updateConfig,
				command,
			}: {
				addRenderer(renderer: { name: string; serverEntrypoint: string }): void;
				command?: string;
				updateConfig(config: {
					vite: {
						plugins: {
							name: string;
							enforce: 'pre';
							load(id: string): string | undefined | Promise<string>;
						}[];
					};
				}): void;
			}) => {
				addRenderer({
					name: 'xph',
					serverEntrypoint: fileURLToPath(new URL('./astro-renderer.js', import.meta.url)),
				});
				updateConfig({
					vite: {
						plugins: [
							{
								name: 'xph-components',
								enforce: 'pre',
								load(id: string) {
									const file = id.split('?')[0];
									if (!file.endsWith('.xph')) return;
									if (!config) throw new Error('xph/astro configuration is not resolved.');
									if (config.output && config.output !== 'static')
										throw new Error(
											'xph imports require static Astro output to generate PHP pages.',
										);
									const root = fileURLToPath(config.root);
									if (!contains(root, file))
										throw new Error('xph components must be inside the project root.');
									if (!entries.includes(file)) entries.push(file);
									const component = relative(root, file)
										.split(sep)
										.join('/')
										.replace(/\.xph$/, '');
									if (command === 'dev') {
										return compile(devDir!, { info() {}, error() {} }).then(
											(result) =>
												`export default ${JSON.stringify({
													xph: true,
													id: component,
													development: true,
													php: result.components.get(file)!.php,
													runtime: resolve(devDir!, 'xph.php'),
												})};`,
										);
									}
									return `export default ${JSON.stringify({ xph: true, id: component, development: command === 'dev' })};`;
								},
							},
						],
					},
				});
			},
			'astro:config:done': ({
				config: resolved,
				injectTypes,
			}: {
				config: AstroConfig;
				injectTypes?: (type: { filename: string; content: string }) => URL;
			}) => {
				injectTypes?.({
					filename: 'xph.d.ts',
					content: `declare module '*.xph' {
  const component: import('astro/runtime/server/index.js').AstroComponentFactory;
  export default component;
}
`,
				});
				config = resolved;
				devDir = fileURLToPath(new URL('xph/', resolved.cacheDir));
			},
			'astro:build:generated': async ({ dir, logger }: { dir: URL; logger: Logger }) => {
				await compile(resolve(fileURLToPath(dir), directory), logger);
				await emitPhpPages(fileURLToPath(dir), directory);
				generated = true;
			},
			'astro:build:done': async ({ dir, logger }: { dir: URL; logger: Logger }) => {
				if (generated) return;
				await compile(resolve(fileURLToPath(dir), directory), logger);
				await emitPhpPages(fileURLToPath(dir), directory);
			},
			'astro:server:setup': async ({ server, logger }: { server: DevServer; logger: Logger }) => {
				if (!config || !devDir)
					throw new Error('xph/astro has not received the resolved Astro configuration.');
				const output = devDir;
				const project = fileURLToPath(config.root);
				const rebuild = async () => {
					const result = await compile(output, logger);
					server.watcher.add([...result.components.keys()]);
				};
				await rebuild();
				const assetPath = `${(config.base || '/').replace(/\/$/, '')}/${directory}/assets/`;
				server.middlewares.use((request, response, next) => {
					if (request.method !== 'GET' && request.method !== 'HEAD') {
						next();
						return;
					}
					const pathname = new URL(request.url ?? '/', 'http://xph.local').pathname;
					if (!pathname.startsWith(assetPath)) {
						next();
						return;
					}
					const filename = pathname.slice(assetPath.length);
					if (!/^[a-f0-9]{12}\.(css|js)$/.test(filename)) {
						next();
						return;
					}
					void readFile(resolve(output, 'assets', filename)).then(
						(content) => {
							response.setHeader(
								'Content-Type',
								filename.endsWith('.css')
									? 'text/css; charset=utf-8'
									: 'text/javascript; charset=utf-8',
							);
							response.setHeader('Cache-Control', 'no-cache');
							response.end(request.method === 'HEAD' ? undefined : content);
						},
						(error) => {
							if (error.code === 'ENOENT') next();
							else next(error);
						},
					);
				});
				let closed = false;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const changed = (_event: string, path: string) => {
					const file = resolve(path);
					if (
						closed ||
						contains(fileURLToPath(config!.cacheDir), file) ||
						contains(fileURLToPath(config!.outDir), file) ||
						!contains(project, file) ||
						file.split(sep).some((part) => part === 'node_modules' || part === '.git')
					)
						return;
					// Frontmatter and browser imports may be TS/JS/CSS files; rebuild those too.
					if (!dependencies.has(file) && !/\.(?:xph|[cm]?[jt]sx?|css)$/.test(file)) return;
					clearTimeout(timer);
					timer = setTimeout(() => {
						queue = queue.then(async () => {
							if (closed) return;
							try {
								await rebuild();
								if (!closed) server.ws.send({ type: 'full-reload', path: '*' });
							} catch (error) {
								logger.error((error as Error).message);
							}
						});
					}, 100);
				};
				server.watcher.on('all', changed);
				server.httpServer?.once('close', () => {
					closed = true;
					clearTimeout(timer);
					server.watcher.off('all', changed);
				});
				logger.info(`Development PHP output: ${output}. Serve it with your PHP application.`);
			},
		},
	};
}
