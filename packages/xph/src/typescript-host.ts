import ts from 'typescript';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

// Only TypeScript's bundled libraries are immutable for this process. Project
// files must be read afresh so rebuilds see edits and deleted imports.
const libraryPrefix = dirname(ts.getDefaultLibFilePath({})) + sep;
const libraries = new Map<string, ts.SourceFile>();
const programs = new Map<string, { options: string; program: ts.Program }>();
const isLibrary = (path: string) =>
	path.startsWith(libraryPrefix) && /^lib\.[^/\\]+\.d\.ts$/.test(path.slice(libraryPrefix.length));

/** Reuse program structure only when all dependencies are bundled libraries.
 * The virtual root is still supplied afresh by the host on every compilation. */
export function expressionProgram(
	file: ts.SourceFile,
	options: ts.CompilerOptions,
	host: ts.CompilerHost,
): ts.Program {
	const references = ts.preProcessFile(file.text, true);
	const local =
		!references.importedFiles.length &&
		!references.referencedFiles.length &&
		!references.typeReferenceDirectives.length &&
		!references.libReferenceDirectives.length;
	const key = JSON.stringify(options);
	const previous = programs.get(file.fileName);
	const program = ts.createProgram(
		[file.fileName],
		options,
		host,
		local && previous?.options === key ? previous.program : undefined,
	);
	programs.delete(file.fileName);
	if (
		local &&
		program.getSourceFiles().every((source) => source === file || isLibrary(source.fileName))
	) {
		programs.set(file.fileName, { options: key, program });
		// Keep a bounded working set for repeated editor queries and small rebuilds.
		if (programs.size > 8) programs.delete(programs.keys().next().value!);
	}
	return program;
}

export function compilerHost(options: ts.CompilerOptions): ts.CompilerHost {
	const host = ts.createCompilerHost(options);
	const original = host.getSourceFile;
	// Program source-file options also contain package metadata. Serializing that
	// for every library load dominated cache hits; compiler options are fixed here.
	const optionsKey = JSON.stringify(options);
	host.getSourceFile = (name, version, onError, fresh) => {
		const path = isAbsolute(name) ? name : resolve(name);
		if (!isLibrary(path)) return original(name, version, onError, fresh);
		const parseKey =
			typeof version === 'number'
				? version
				: `${version.languageVersion}:${version.impliedNodeFormat}:${version.jsDocParsingMode}`;
		const key = `${path}:${optionsKey}:${parseKey}`;
		const cached = libraries.get(key);
		if (cached && !fresh) return cached;
		const file = original(name, version, onError, fresh);
		if (file) libraries.set(key, file);
		return file;
	};
	return host;
}
