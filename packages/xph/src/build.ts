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
import { compile } from './compiler.js';
import { analyzePHP } from './php.js';
import type { CompileResult, Config, Diagnostic } from './types.js';
export interface BuildOptions {
	write?: boolean;
	skipPhpCheck?: boolean;
}

export interface BuildResult {
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
			unchanged && previous.bindings === signature
				? previous.result
				: await compile(source, {
						filename: file,
						components: bindings,
						scopeId: id(file),
						compressHTML: config.compressHTML,
						debug: config.debug,
						scopedStyleStrategy: config.scopedStyleStrategy,
					});
		nextCache.set(file, { source, bindings: signature, result });
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
	if (options.skipPhpCheck) {
		diagnostics.push({
			source: 'php',
			severity: 'warning',
			start: 0,
			end: 0,
			message: 'PHP syntax validation skipped (--skip-php-check).',
		});
	} else {
		for (const [file, component] of components)
			diagnostics.push(
				...(await analyzePHP(component, config)).map((d) => ({ ...d, filename: file })),
			);
	}
	const manifest: BuildResult['manifest'] = {};
	if (options.write === false || diagnostics.some((d) => d.severity === 'error'))
		return { components, diagnostics, outDir, manifest };
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
				assets: result.assets.map((a) => ({
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
		await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
		await writeFile(
			join(stage, 'xph.php'),
			"<?php\nrequire_once __DIR__ . '/runtime.php';\n\\Xph\\configure(__DIR__);\n",
		);
		// Only replace files owned by xph; callers may keep a preview entrypoint in outDir.
		await mkdir(outDir, { recursive: true });
		for (const name of ['components', 'assets']) {
			await rm(join(outDir, name), { recursive: true, force: true });
			await rename(join(stage, name), join(outDir, name));
		}
		for (const name of ['runtime.php', 'manifest.json', 'xph.php'])
			await rename(join(stage, name), join(outDir, name));
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
	return { components, diagnostics, outDir, manifest };
}
