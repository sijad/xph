import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { BlockDefinition } from './index.js';

/** Evaluate metadata in this package, without adding exports or hooks to XPH. */
export async function definition(filename: string): Promise<BlockDefinition | undefined> {
	const source = await readFile(filename, 'utf8');
	const front = /^---[^\S\r\n]*\r?\n([\s\S]*?)^---[^\S\r\n]*(?:\r?\n|$)/m.exec(source);
	if (!front || front.index !== 0) return;
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
					plugin.onLoad({ filter: /\.xph$/ }, () => ({ contents: 'export default undefined;' }));
				},
			},
		],
	});
	const module = { exports: {} as { block?: BlockDefinition } };
	vm.runInNewContext(
		result.outputFiles[0].text,
		{
			module,
			exports: module.exports,
			require: createRequire(filename),
			console,
			process,
			Buffer,
		},
		{ timeout: 2000 },
	);
	const value = module.exports.block;
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
