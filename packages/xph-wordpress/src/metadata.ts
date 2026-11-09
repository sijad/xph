import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { BlockDefinition, TemplateMetadata } from './index.js';

/** Evaluate metadata in this package, without adding exports or hooks to XPH. */
async function exportsOf(
	filename: string,
): Promise<{ block?: BlockDefinition; template?: TemplateMetadata }> {
	const source = await readFile(filename, 'utf8');
	const front = /^---[^\S\r\n]*\r?\n([\s\S]*?)^---[^\S\r\n]*(?:\r?\n|$)/m.exec(source);
	if (!front || front.index !== 0) return {};
	const result = await build({
		stdin: { contents: front[1], resolveDir: dirname(filename), loader: 'ts' },
		bundle: true,
		write: false,
		platform: 'node',
		format: 'cjs',
		logLevel: 'silent',
		plugins: [
			{
				name: 'component-imports',
				setup(plugin) {
					plugin.onResolve({ filter: /\.svg$/ }, (args) => ({
						path: args.path,
						namespace: 'xph-metadata-svg',
					}));
					plugin.onLoad({ filter: /.*/, namespace: 'xph-metadata-svg' }, () => ({
						contents: 'export default undefined;',
						loader: 'js',
					}));
					plugin.onResolve({ filter: /\.css$/ }, (args) => ({
						path: args.path,
						namespace: 'xph-metadata-css',
					}));
					plugin.onLoad({ filter: /.*/, namespace: 'xph-metadata-css' }, () => ({
						contents: '',
						loader: 'js',
					}));
					plugin.onLoad({ filter: /\.xph$/ }, () => ({ contents: 'export default undefined;' }));
				},
			},
		],
	});
	const module = { exports: {} as { block?: BlockDefinition; template?: TemplateMetadata } };
	vm.runInNewContext(
		result.outputFiles[0].text,
		{
			module,
			exports: module.exports,
			require: createRequire(filename),
			console,
			process,
			Buffer,
			TextEncoder,
			TextDecoder,
		},
		{ timeout: 2000 },
	);
	return module.exports;
}

export async function templateDefinition(filename: string): Promise<TemplateMetadata | undefined> {
	return (await exportsOf(filename)).template;
}

export async function definition(filename: string): Promise<BlockDefinition | undefined> {
	const value = (await exportsOf(filename)).block;
	if (value === undefined) return;
	if (!value || !value.metadata || !value.editor)
		throw new Error('Export block using defineBlock(metadata).');
	return JSON.parse(
		JSON.stringify(value, (_key, value) => {
			if (
				['function', 'symbol', 'bigint'].includes(typeof value) ||
				(typeof value === 'number' && !Number.isFinite(value))
			)
				throw new Error('Block definitions must contain only JSON values.');
			return value;
		}),
	);
}
