import { dirname, join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { build as bundle } from 'esbuild';
import type { Config } from './types.js';

/** Config files in lookup order. */
export const configFiles = ['xph.config.ts'];

/** The first config file in a directory, if any. */
export function findConfig(directory: string): string | undefined {
	return configFiles.map((name) => join(directory, name)).find((path) => existsSync(path));
}

/** Bundle and evaluate an xph.config.ts; `root` defaults to its directory. */
export async function loadConfig(path: string): Promise<Config> {
	let code;
	try {
		code = await readFile(path, 'utf8');
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
		// Keeps the code so callers can fall back to defaults.
		throw Object.assign(
			new Error(
				`No config found at ${relative(process.cwd(), path) || path}. Create xph.config.ts in your project, for example:\n\n` +
					`  export default { srcDir: 'src', outDir: 'dist' };\n\n` +
					'or pass the path to your config as an argument.',
			),
			{ code: 'ENOENT' },
		);
	}
	const output = await bundle({
		stdin: { contents: code, resolveDir: dirname(path), loader: 'ts' },
		bundle: true,
		write: false,
		platform: 'node',
		format: 'esm',
	});
	const mod = await import(
		'data:text/javascript;base64,' + Buffer.from(output.outputFiles![0].text).toString('base64')
	);
	return { root: dirname(path), ...mod.default };
}
