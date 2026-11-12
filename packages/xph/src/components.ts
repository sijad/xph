import { dirname, resolve } from 'node:path';
import type { CompileOptions, CompileResult } from './types.js';

/** What a component's final compile needs to know about each component it renders. */
export type ComponentBinding = NonNullable<CompileOptions['components']>[string];

/**
 * Each `.xph` import of `file`, resolved to an absolute path. Components compile in two
 * passes: a contracts-only pass finds these imports, then the final compile type-checks
 * their usage against the bindings built from each import's contract.
 */
export function componentImports(file: string, result: Pick<CompileResult, 'imports'>) {
	return Object.entries(result.imports).map(([name, path]) => ({
		name,
		file: resolve(dirname(file), path),
	}));
}
