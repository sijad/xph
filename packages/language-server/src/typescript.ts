import { statSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import ts from 'typescript';

/** The compiler's options for template expressions: server-side code, so no DOM library. */
export const virtualOptions: ts.CompilerOptions = {
	strict: true,
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	jsx: ts.JsxEmit.Preserve,
	noEmit: true,
	allowJs: true,
	allowImportingTsExtensions: true,
	skipLibCheck: true,
	types: [],
	lib: ['lib.es2022.d.ts'],
};

const libraries = dirname(ts.getDefaultLibFilePath(virtualOptions)) + sep;

/**
 * One long-lived TypeScript language service for every component's virtual file.
 * Creating a service per request re-parsed and re-bound TypeScript's libraries each time,
 * which dominated hover and completion latency. Files are versioned instead: virtual files
 * by content, open documents by editor version, libraries never, other files by mtime.
 */
export class VirtualTypeScript {
	private virtual = new Map<string, { code: string; version: number }>();
	private root?: string;
	private service: ts.LanguageService;

	constructor(document: (file: string) => { text: string; version: number } | undefined) {
		const read = (file: string) =>
			this.virtual.get(file)?.code ?? document(file)?.text ?? ts.sys.readFile(file);
		const host: ts.LanguageServiceHost = {
			getScriptFileNames: () => (this.root ? [this.root] : []),
			getScriptVersion: (file) => {
				const virtual = this.virtual.get(file);
				if (virtual) return 'virtual:' + virtual.version;
				const open = document(file);
				if (open) return 'document:' + open.version;
				if (file.startsWith(libraries)) return 'library';
				try {
					return 'file:' + statSync(file).mtimeMs;
				} catch {
					return 'missing';
				}
			},
			getScriptSnapshot: (file) => {
				const text = read(file);
				return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
			},
			getCurrentDirectory: () => (this.root ? dirname(this.root) : process.cwd()),
			getCompilationSettings: () => virtualOptions,
			getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
			fileExists: (file) => this.virtual.has(file) || !!document(file) || ts.sys.fileExists(file),
			readFile: read,
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
			realpath: ts.sys.realpath,
		};
		this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
	}

	/**
	 * Focus the service on one virtual file with the given code. Call this again after any
	 * `await`: another request may have focused a different file in between.
	 */
	use(file: string, code: string): ts.LanguageService {
		const previous = this.virtual.get(file);
		if (previous?.code !== code)
			this.virtual.set(file, { code, version: (previous?.version ?? 0) + 1 });
		this.root = file;
		return this.service;
	}

	forget(file: string) {
		this.virtual.delete(file);
		if (this.root === file) this.root = undefined;
	}
}

let domStyle: { checker: ts.TypeChecker; type: ts.Type } | undefined;
/**
 * Declarations of a CSS property in the DOM library's CSSStyleDeclaration, where MDN documents
 * it. Templates are checked without the DOM, so this looks it up in a separate program, built once.
 */
export function cssPropertyDeclarations(key: string): ts.Declaration[] {
	if (key.startsWith('--')) return [];
	if (!domStyle) {
		const file = '/__xph_dom__.ts';
		const options = { ...virtualOptions, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] };
		const host = ts.createCompilerHost(options);
		const read = host.getSourceFile;
		host.getSourceFile = (name, version, ...rest) =>
			name === file
				? ts.createSourceFile(name, 'export {};', version)
				: read(name, version, ...rest);
		const checker = ts.createProgram([file], options, host).getTypeChecker();
		const symbol = checker.resolveName(
			'CSSStyleDeclaration',
			undefined,
			ts.SymbolFlags.Type,
			false,
		);
		if (!symbol) return [];
		domStyle = { checker, type: checker.getDeclaredTypeOfSymbol(symbol) };
	}
	const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase());
	const property = domStyle.type
		.getProperties()
		.find((symbol) => symbol.name === key || kebab(symbol.name) === key);
	return property?.getDeclarations() ?? [];
}
