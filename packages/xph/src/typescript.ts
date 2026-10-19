import ts from 'typescript';
import type { Diagnostic } from './types.js';
/** Check browser programs independently from server and build-time bindings. */
export function checkBrowser(code: string, filename: string, offset: number): Diagnostic[] {
	const options: ts.CompilerOptions = {
		strict: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		noEmit: true,
		skipLibCheck: true,
		types: [],
		lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
	};
	const host = ts.createCompilerHost(options),
		original = host.getSourceFile;
	host.getSourceFile = (name, version, ...rest) =>
		name === filename
			? ts.createSourceFile(name, code, version, true, ts.ScriptKind.TS)
			: original(name, version, ...rest);
	const program = ts.createProgram([filename], options, host),
		file = program.getSourceFile(filename)!;
	return ts
		.getPreEmitDiagnostics(program)
		.filter((d) => d.file === file)
		.map((d) => ({
			message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
			severity: 'error',
			source: 'typescript',
			start: offset + (d.start ?? 0),
			end: offset + (d.start ?? 0) + (d.length ?? 1),
		}));
}
