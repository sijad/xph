import {
	readFile,
	writeFile,
	mkdir,
	copyFile,
	rename,
	rm,
	readdir,
	realpath,
} from 'node:fs/promises';
import { dirname, resolve, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build as bundle } from 'esbuild';
import { compile } from './compiler.js';
import { analyzePHP } from './php.js';
import { phpLiteral } from './contracts.js';
import type { CompileResult, Config, Diagnostic } from './types.js';
export interface BuildOptions {
	write?: boolean;
	skipPhpCheck?: boolean;
	/** Source-only watcher event; external CSS inputs are unchanged. */
	sourceOnly?: boolean;
}

export interface BuildResult {
	compiled: number;
	components: Map<string, CompileResult>;
	diagnostics: Diagnostic[];
	outDir: string;
	manifest: Record<
		string,
		{ file: string; assets: { type: string; url: string }[]; dependencies: string[] }
	>;
}
export async function build(config: Config, options: BuildOptions = {}): Promise<BuildResult> {
	return buildProject(config, options);
}

interface CachedComponent {
	source: string;
	bindings: string;
	result: CompileResult;
	phpDiagnostics?: Diagnostic[];
}

/** Keep compilation results between builds of one fixed project configuration. */
export function createBuilder(config: Config) {
	const cache = new Map<string, CachedComponent>();
	const project = { ...config, root: resolve(config.root ?? '.') };
	return (options: BuildOptions = {}) => buildProject(project, options, cache);
}

async function buildProject(
	config: Config,
	options: BuildOptions,
	cache?: Map<string, CachedComponent>,
): Promise<BuildResult> {
	const root = resolve(config.root ?? '.'),
		outDir = resolve(root, config.outDir ?? 'dist');
	if (outDir === root || root.startsWith(outDir + sep))
		throw new Error('outDir must not contain the project root.');
	const srcDir = resolve(root, config.srcDir ?? 'src');
	const inside = (parent: string, file: string) => file === parent || file.startsWith(parent + sep);
	if (!inside(root, srcDir)) throw new Error('srcDir must be inside the project root.');
	const realRoot = await realpath(root);
	let realSource: string;
	try {
		realSource = await realpath(srcDir);
	} catch {
		throw new Error('Unable to read source directory: ' + srcDir);
	}
	if (!inside(realRoot, realSource) || realSource !== resolve(realRoot, relative(root, srcDir)))
		throw new Error('srcDir must be inside the project root.');
	const excluded = (file: string) =>
		inside(outDir, file) ||
		relative(root, file)
			.split(sep)
			.some((part) => part === 'node_modules' || part === '.git');
	const sources: string[] = [];
	async function discover(directory: string): Promise<void> {
		for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		)) {
			const file = join(directory, entry.name);
			if (excluded(file) || entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) await discover(file);
			else if (entry.isFile() && file.endsWith('.xph')) sources.push(file);
		}
	}
	if (!excluded(srcDir)) await discover(srcDir);
	sources.sort();
	let compiled = 0;
	const discovered = new Set(sources);
	const nextCache = new Map<string, CachedComponent>();
	const components = new Map<string, CompileResult>(),
		diagnostics: Diagnostic[] = [],
		active = new Set<string>();
	const id = (file: string) =>
		relative(srcDir, file)
			.split(sep)
			.join('/')
			.replace(/\.xph$/, '');
	async function visit(file: string): Promise<CompileResult> {
		if (active.has(file)) throw new Error('Circular component dependency: ' + file);
		const cached = components.get(file);
		if (cached) return cached;
		if (!discovered.has(file) || !inside(realSource, await realpath(file)))
			throw new Error(
				'Components must be .xph files inside srcDir and outside excluded directories: ' + file,
			);
		active.add(file);
		const source = await readFile(file, 'utf8');
		const previous = cache?.get(file);
		const unchanged = previous?.source === source;
		// First pass discovers imports and contracts; component checking runs after dependencies resolve.
		const first = unchanged
			? previous.result
			: await compile(source, { filename: file, contractsOnly: true });
		const bindings: NonNullable<Parameters<typeof compile>[1]>['components'] = {};
		for (const [name, path] of Object.entries(first.imports)) {
			const target = resolve(dirname(file), path);
			const child = await visit(target);
			bindings[name] = { id: id(target), props: child.props };
		}
		const signature = JSON.stringify(bindings);
		const result =
			// Styles can depend on PostCSS configuration and plugin inputs outside the component.
			unchanged &&
			previous.bindings === signature &&
			(options.sourceOnly || !/<style\b/.test(source))
				? previous.result
				: await compile(source, {
						filename: file,
						deferScripts: true,
						components: bindings,
						scopeId: id(file),
						compressHTML: config.compressHTML,
						debug: config.debug,
						scopedStyleStrategy: config.scopedStyleStrategy,
					});
		if (result !== previous?.result) compiled++;
		nextCache.set(file, {
			source,
			bindings: signature,
			result,
			phpDiagnostics: result === previous?.result ? previous.phpDiagnostics : undefined,
		});
		components.set(file, result);
		active.delete(file);
		diagnostics.push(...result.diagnostics.map((d) => ({ ...d, filename: file })));
		return result;
	}
	for (const file of sources) await visit(file);
	if (cache) {
		cache.clear();
		for (const [file, entry] of nextCache) cache.set(file, entry);
	}
	// Bundle all browser entry points together so shared modules have one identity.
	const entries = new Map<string, { file: string; content: string }>();
	for (const [file, result] of components)
		for (const asset of result.assets)
			if (asset.type === 'js')
				entries.set(`entry-${entries.size}`, { file, content: asset.content });
	if (entries.size && !diagnostics.some((d) => d.severity === 'error')) {
		try {
			const output = await bundle({
				entryPoints: [...entries.keys()],
				outdir: resolve(root, '.xph-browser'),
				entryNames: '[name]-[hash]',
				chunkNames: 'shared-[hash]',
				bundle: true,
				splitting: true,
				format: 'esm',
				platform: 'browser',
				minify: true,
				write: false,
				logLevel: 'silent',
				plugins: [
					{
						name: 'xph-browser',
						setup(plugin) {
							plugin.onResolve({ filter: /^entry-\d+$/ }, (args) =>
								args.kind === 'entry-point'
									? { path: args.path, namespace: 'xph-browser' }
									: undefined,
							);
							plugin.onLoad({ filter: /.*/, namespace: 'xph-browser' }, (args) => {
								const entry = entries.get(args.path)!;
								return { contents: entry.content, loader: 'ts', resolveDir: dirname(entry.file) };
							});
						},
					},
				],
			});
			for (const [file, result] of components)
				components.set(file, { ...result, assets: result.assets.filter((a) => a.type !== 'js') });
			for (const asset of output.outputFiles) {
				const filename = relative(resolve(root, '.xph-browser'), asset.path);
				const key = filename.match(/^(entry-\d+)-/)?.[1];
				const file = key ? entries.get(key)!.file : entries.values().next().value!.file;
				components.get(file)!.assets.push({
					type: filename.endsWith('.css') ? 'css' : 'js',
					filename,
					content: asset.text,
					...(key ? {} : { imported: true }),
				});
			}
		} catch (error) {
			diagnostics.push({
				source: 'xph',
				severity: 'error',
				start: 0,
				end: 0,
				message: `Asset: ${(error as Error).message}`,
			});
		}
	}
	if (options.skipPhpCheck) {
		diagnostics.push({
			source: 'php',
			severity: 'warning',
			start: 0,
			end: 0,
			message: 'PHP syntax validation skipped (--skip-php-check).',
		});
	} else {
		for (const [file, component] of components) {
			const entry = nextCache.get(file)!;
			const checked = entry.phpDiagnostics ?? (await analyzePHP(component, config));
			// Retry failed checks: an executable or other external condition may recover.
			if (!checked.length) entry.phpDiagnostics = checked;
			diagnostics.push(...checked.map((d) => ({ ...d, filename: file })));
		}
	}
	const manifest: BuildResult['manifest'] = {};
	if (options.write === false || diagnostics.some((d) => d.severity === 'error'))
		return { compiled, components, diagnostics, outDir, manifest };
	const stage = outDir + '.xph-' + randomUUID();
	await mkdir(join(stage, 'components'), { recursive: true });
	await mkdir(join(stage, 'assets'), { recursive: true });
	try {
		for (const [file, result] of components) {
			const key = id(file),
				target = 'components/' + key + '.php';
			await mkdir(dirname(join(stage, target)), { recursive: true });
			await writeFile(join(stage, target), result.php);
			for (const asset of result.assets)
				await writeFile(join(stage, 'assets', asset.filename), asset.content);
			manifest[key] = {
				file: target,
				assets: result.assets
					.filter((a) => !a.imported)
					.map((a) => ({
						type: a.type,
						url: (config.assetBase ?? '/assets/').replace(/\/?$/, '/') + a.filename,
					})),
				dependencies: Object.values(result.imports).map((p) => id(resolve(dirname(file), p))),
			};
		}
		await copyFile(
			fileURLToPath(new URL('../runtime/runtime.php', import.meta.url)),
			join(stage, 'runtime.php'),
		);
		// Resolve each root independently: shared dependencies must retain DFS order
		// even when a parent's own assets overlap those of its dependencies.
		const assets: Record<string, { type: string; url: string }[]> = {};
		for (const component of Object.keys(manifest)) {
			const seen = new Set<string>();
			const urls = new Set<string>();
			const records: { type: string; url: string }[] = [];
			const visit = (id: string): void => {
				if (seen.has(id)) return;
				seen.add(id);
				const entry = manifest[id];
				for (const dependency of entry.dependencies) visit(dependency);
				for (const asset of entry.assets) {
					if (urls.has(asset.url)) continue;
					urls.add(asset.url);
					records.push(asset);
				}
			};
			visit(component);
			assets[component] = records;
		}
		await writeFile(
			join(stage, 'manifest.php'),
			`<?php\nreturn ${phpLiteral({ components: manifest, assets })};\n`,
		);
		await writeFile(
			join(stage, 'xph.php'),
			"<?php\nrequire_once __DIR__ . '/runtime.php';\n\\Xph\\configure(__DIR__);\n",
		);
		// Only replace files owned by xph; callers may keep a preview entrypoint in outDir.
		await mkdir(outDir, { recursive: true });
		async function publishFile(source: string, target: string) {
			try {
				if ((await readFile(source)).equals(await readFile(target))) return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
			await rename(source, target);
		}
		async function publishDirectory(source: string, target: string) {
			await mkdir(target, { recursive: true });
			const entries = await readdir(source, { withFileTypes: true });
			const names = new Set(entries.map((entry) => entry.name));
			for (const name of await readdir(target))
				if (!names.has(name)) await rm(join(target, name), { recursive: true, force: true });
			for (const entry of entries) {
				const from = join(source, entry.name),
					to = join(target, entry.name);
				if (entry.isDirectory()) await publishDirectory(from, to);
				else await publishFile(from, to);
			}
		}
		for (const name of ['components', 'assets'])
			await publishDirectory(join(stage, name), join(outDir, name));
		for (const name of ['runtime.php', 'manifest.php', 'xph.php'])
			await publishFile(join(stage, name), join(outDir, name));
		await rm(join(outDir, 'manifest.json'), { force: true });
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
	return { compiled, components, diagnostics, outDir, manifest };
}
