export interface Diagnostic {
	message: string;
	severity: 'error' | 'warning';
	start: number;
	end: number;
	source: 'xph' | 'typescript' | 'php';
	filename?: string;
}
export interface Mapping {
	generatedStart: number;
	generatedEnd: number;
	sourceStart: number;
	sourceEnd: number;
}
export type Contract =
	| { kind: 'string' | 'number' | 'boolean' | 'null' }
	| { kind: 'literal'; value: string | number | boolean }
	| { kind: 'array'; element: Contract }
	| { kind: 'function'; parameters: { name: string; type: Contract }[]; returns: Contract }
	| { kind: 'object'; fields: Record<string, { type: Contract; optional: boolean }> }
	| { kind: 'union'; types: Contract[] };
export interface Asset {
	type: 'css' | 'js';
	content: string;
	filename: string;
}
export type ScopedStyleStrategy = 'where' | 'class' | 'attribute';
export interface CompileOptions {
	/** Collapse static HTML whitespace at compile time. Defaults to true. */
	compressHTML?: boolean;
	/** Style scoping selector strategy. Defaults to attribute. */
	scopedStyleStrategy?: ScopedStyleStrategy;
	/** Internal discovery pass: contracts and imports only. */ contractsOnly?: boolean;
	/** Internal editor query: retain recovered parser nodes in incomplete templates. */
	recover?: boolean;
	scopeId?: string;
	filename?: string;
	components?: Record<string, { id: string; props: Contract }>;
	assetBase?: string;
}
export interface CompileResult {
	php: string;
	diagnostics: Diagnostic[];
	mappings: Mapping[];
	virtual: { code: string; mappings: Mapping[] };
	assets: Asset[];
	imports: Record<string, string>;
	props: Contract;
	server: Contract;
	ir: IR[];
}
export type IR =
	| { kind: 'slot-callback'; parameters: string[]; children: IR[]; start: number; end: number }
	| { kind: 'text'; value: string; start: number; end: number }
	| { kind: 'expression'; code: string; start: number; end: number }
	| {
			kind: 'element';
			name: string;
			attributes: { name?: string; code: string; start?: number; end?: number }[];
			children: IR[];
			start: number;
			end: number;
			fragment?: boolean;
			component?: string;
			tag?: string;
			html?: string;
	  }
	| { kind: 'branch'; test: string; yes: IR[]; no: IR[]; start: number; end: number }
	| {
			kind: 'loop';
			value: string;
			item: string;
			index?: string;
			children: IR[];
			start: number;
			end: number;
	  }
	| { kind: 'slot'; name?: string; children: IR[]; start: number; end: number };
export interface Config {
	/** Collapse static HTML whitespace at compile time. Defaults to true. */
	compressHTML?: boolean;
	/** Style scoping selector strategy. Defaults to attribute. */
	scopedStyleStrategy?: ScopedStyleStrategy;
	/** Discover every .xph file under this directory. Defaults to src. */
	srcDir?: string;
	outDir?: string;
	root?: string;
	assetBase?: string;
	php?: string;
	/** Optional PHP language server, for example Intelephense over stdio. */
	phpLanguageServer?: {
		command: string;
		args?: string[];
		initializationOptions?: Record<string, unknown>;
		settings?: Record<string, unknown>;
	};
}
