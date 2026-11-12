import { createHash } from 'node:crypto';
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
