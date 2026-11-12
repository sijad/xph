import ts from 'typescript';
import { compilerHost, isLibrary } from './typescript-host.js';
import type { Diagnostic } from './types.js';
const previous = new Map<string, ts.Program>();
/** Check browser programs independently from server and build-time bindings. */
export function checkBrowser(code: string, filename: string, offset: number): Diagnostic[] {
	const options: ts.CompilerOptions = {
		strict: true,
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		noEmit: true,
		allowJs: true,
		allowImportingTsExtensions: true,
		skipLibCheck: true,
		types: [],
		lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
	};
	const host = compilerHost(options),
		original = host.getSourceFile;
	host.getSourceFile = (name, version, ...rest) =>
		name === filename
			? ts.createSourceFile(name, code, version, true, ts.ScriptKind.TS)
			: original(name, version, ...rest);
	// Reuse the previous program's structure when it only contained this script and bundled
	// libraries; like expressionProgram, never reuse module resolutions of project files.
	const program = ts.createProgram([filename], options, host, previous.get(filename)),
		file = program.getSourceFile(filename)!;
	previous.delete(filename);
	if (program.getSourceFiles().every((source) => source === file || isLibrary(source.fileName))) {
		previous.set(filename, program);
		if (previous.size > 8) previous.delete(previous.keys().next().value!);
	}
	return [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)].map(
		(d) => ({
			message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
			severity: 'error',
			source: 'typescript',
			start: offset + (d.start ?? 0),
			end: offset + (d.start ?? 0) + (d.length ?? 1),
		}),
	);
}
