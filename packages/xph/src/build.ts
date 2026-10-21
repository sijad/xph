import { readFile, writeFile, mkdir, copyFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { compile } from './compiler.js';
import type { CompileResult, Config, Diagnostic } from './types.js';
export interface BuildResult {
	components: Map<string, CompileResult>;
	diagnostics: Diagnostic[];
	outDir: string;
	manifest: Record<
		string,
		{ file: string; assets: { type: string; url: string }[]; dependencies: string[] }
	>;
}
export async function build(config: Config): Promise<BuildResult> {
	const root = resolve(config.root ?? '.'),
		outDir = resolve(root, config.outDir ?? 'dist');
	if (outDir === root || root.startsWith(outDir + sep))
		throw new Error('outDir must not contain the project root.');
	const components = new Map<string, CompileResult>(),
		diagnostics: Diagnostic[] = [],
		active = new Set<string>();
	const id = (file: string) =>
		relative(root, file)
			.split(sep)
			.join('/')
			.replace(/\.xph$/, '');
	async function visit(file: string): Promise<CompileResult> {
		if (active.has(file)) throw new Error('Circular component dependency: ' + file);
		const cached = components.get(file);
		if (cached) return cached;
		if (!file.startsWith(root + sep) || !file.endsWith('.xph'))
			throw new Error('Components must be .xph files inside root: ' + file);
		active.add(file);
		const source = await readFile(file, 'utf8');
		// First pass discovers imports and contracts; component checking runs after dependencies resolve.
		const first = await compile(source, { filename: file, contractsOnly: true });
		const bindings: NonNullable<Parameters<typeof compile>[1]>['components'] = {};
		for (const [name, path] of Object.entries(first.imports)) {
			const target = resolve(dirname(file), path);
			const child = await visit(target);
			bindings[name] = { id: id(target), props: child.props };
		}
		const result = await compile(source, {
			filename: file,
			components: bindings,
			scopeId: id(file),
			compressHTML: config.compressHTML,
			scopedStyleStrategy: config.scopedStyleStrategy,
		});
		components.set(file, result);
		active.delete(file);
		diagnostics.push(...result.diagnostics.map((d) => ({ ...d, filename: file })));
		return result;
	}
	for (const entry of config.entries) await visit(resolve(root, entry));
	const manifest: BuildResult['manifest'] = {};
	if (diagnostics.some((d) => d.severity === 'error'))
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
