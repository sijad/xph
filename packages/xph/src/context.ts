import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Metafile } from 'esbuild';
import type { CompileOptions, CompileResult, Diagnostic, ScopedStyleStrategy } from './types.js';

export const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/** State shared by the compiler stages of one component. */
export interface CompileContext {
	source: string;
	filename: string;
	options: CompileOptions;
	debug: boolean;
	/** Stable per-component hash for scoped selectors and keyframes. */
	id: string;
	strategy: ScopedStyleStrategy;
	/** `data-xph-<id>`, the attribute-strategy scope marker. */
	scopeAttribute: string;
	/** `xph-<id>`, the class and where strategies' scope marker. */
	scopeClass: string;
	result: CompileResult;
	diagnostics: Diagnostic[];
	error(message: string, start?: number, end?: number): void;
}

const dependency = (file: string) => !file.split(/[/\\]/).includes('node_modules');

/** Record files besides the component that compiling it read; dependencies are not tracked. */
export function addInputs(ctx: CompileContext, files: Iterable<string>) {
	const inputs = (ctx.result.inputs ??= []);
	for (const file of files)
		if (file !== ctx.filename && dependency(file) && !inputs.includes(file)) inputs.push(file);
}

/** Files esbuild read: a metafile's inputs, or the files a failed build reported errors in. */
export function esbuildInputs(source: { metafile?: Metafile } | unknown): string[] {
	const metafile = (source as { metafile?: Metafile }).metafile;
	if (metafile)
		// Inputs are relative to the working directory; other namespaces are prefixed with theirs.
		return Object.keys(metafile.inputs)
			.filter((input) => input !== '<stdin>' && !/^[\w-]{2,}:/.test(input))
			.map((input) => resolve(input));
	const errors = (source as { errors?: { location?: { file?: string } | null }[] }).errors;
	return (errors ?? []).flatMap((e) =>
		e.location?.file && e.location.file !== '<stdin>' ? [resolve(e.location.file)] : [],
	);
}
