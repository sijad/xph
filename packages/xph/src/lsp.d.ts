// dist/lsp.js is the language server (packages/language-server) bundled by scripts/bundle-lsp.mjs,
// so `xph lsp` works from a single install. This declares the entry point the CLI loads.
import type { Config } from './types.js';
export declare function start(
	input?: NodeJS.ReadableStream,
	output?: NodeJS.WritableStream,
	config?: Config,
): void;
