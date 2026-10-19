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
export interface CompileOptions {
	/** Internal discovery pass: contracts and imports only. */ contractsOnly?: boolean;
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
	| { kind: 'text'; value: string; start: number; end: number }
	| { kind: 'expression'; code: string; start: number; end: number }
	| {
			kind: 'element';
			name: string;
			attributes: { name: string; code: string }[];
			children: IR[];
			start: number;
			end: number;
			component?: string;
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
	| { kind: 'slot'; children: IR[]; start: number; end: number };
export interface Config {
	entries: string[];
	outDir?: string;
	root?: string;
	assetBase?: string;
	php?: string;
}
