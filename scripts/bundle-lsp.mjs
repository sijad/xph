// Bundle the private language-server package into xph's dist/lsp.js (declared by src/lsp.d.ts).
// The server imports `xph` itself, which stays external and resolves to the installed package.
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const server = fileURLToPath(new URL('../packages/language-server/src/', import.meta.url));
const dist = fileURLToPath(new URL('../packages/xph/dist/', import.meta.url));
await build({
	entryPoints: [server + 'index.ts'],
	outfile: dist + 'lsp.js',
	bundle: true,
	mainFields: ['module', 'main'],
	external: ['xph', 'typescript', 'prettier', 'prettier-plugin-astro'],
	platform: 'node',
	format: 'esm',
	banner: {
		js: "import { createRequire as __xphCreateRequire } from 'node:module'; const require = __xphCreateRequire(import.meta.url);",
	},
	logLevel: 'info',
});
copyFileSync(server + 'xph.d.ts', dist + 'xph.d.ts');
