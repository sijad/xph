import { resolve, relative, sep } from 'node:path';
import { watch } from 'chokidar';
import type { Config } from './types.js';

export function watchSources(config: Config) {
	const root = resolve(config.root ?? '.');
	const outDir = resolve(root, config.outDir ?? 'dist');
	return watch(resolve(root, config.srcDir ?? 'src'), {
		ignored: (path, stats) =>
			path === outDir ||
			path.startsWith(outDir + sep) ||
			path.startsWith(outDir + '.xph-') ||
			relative(root, path)
				.split(sep)
				.some((part) => part === 'node_modules' || part === '.git') ||
			(stats?.isFile() === true && !path.endsWith('.xph')),
		ignoreInitial: true,
		followSymlinks: false,
	});
}
