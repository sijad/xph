// Bundle the private xph-dev package into a runtime package's dist/dev.js (declared by its src/dev.d.ts).
// Run from the runtime package; xph-dev's own dependencies stay external and must be its dependencies.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

await build({
	entryPoints: [fileURLToPath(new URL('../packages/xph-dev/src/index.ts', import.meta.url))],
	outfile: resolve('dist/dev.js'),
	bundle: true,
	packages: 'external',
	platform: 'node',
	format: 'esm',
	logLevel: 'info',
});
