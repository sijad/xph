import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { decodeHTMLAttribute } from 'entities';
import { parseTemplate, isTemplateElement, type TemplateRoot } from './astro.js';
import {
	contract,
	hasFunction,
	interfaceContract,
	phpLiteral,
	SyntaxOnlyContractError,
} from './contracts.js';
import { contractResolver } from './resolved-contracts.js';
import type { CompileContext } from './context.js';
import type { Contract, Mapping } from './types.js';

interface SvgImport {
	/** Root `<svg>` attributes as PHP literals, used as overridable defaults. */
	attributes: { name: string; code: string }[];
	content: string;
}
export interface Frontmatter {
	code: string;
	/** Source offset of `code`. */
	start: number;
	/** Declarations that precede the template expressions in the virtual TypeScript file. */
	prefix: string;
	prefixMappings: Mapping[];
	/** Statements bundled and run at build time to produce template constants. */
	executable: string;
	constantNames: string[];
	cssImports: string[];
	svgImports: Map<string, SvgImport>;
}

const JSX_PRELUDE = `export {};\ndeclare global { namespace JSX { type Element = string & { readonly __xphMarkup: unique symbol }; type ElementType = string | ((props: any) => Element); interface IntrinsicElements { [name: string]: any } } }\n`;

/** Classify frontmatter statements, resolve Props/Server contracts and declare template globals. */
export async function analyzeFrontmatter(
	ctx: CompileContext,
	ast: TemplateRoot,
): Promise<Frontmatter> {
	const { source, filename, result } = ctx;
	const front = ast.children.find((n) => n.type === 'frontmatter');
	const code = front?.type === 'frontmatter' ? front.value : '';
	const start = front ? source.indexOf(code, 3) : 0;
	const sf = ts.createSourceFile(
		filename + '.ts',
		code,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const fm: Frontmatter = {
		code,
		start,
		prefix: JSX_PRELUDE,
		prefixMappings: [],
		executable: '',
		constantNames: [],
		cssImports: [],
		svgImports: new Map(),
	};
	const report = (e: unknown, node: ts.Node) =>
		ctx.error((e as Error).message, start + node.getStart(sf), start + node.end);
	// Copy a statement into the virtual file, mapping it back to its frontmatter source.
	const declare = (text: string, node: ts.Node) => {
		const generatedStart = fm.prefix.length;
		fm.prefix += text + '\n';
		const removed = node.getText(sf).length - text.length;
		fm.prefixMappings.push({
			generatedStart,
			generatedEnd: fm.prefix.length - 1,
			sourceStart: start + node.getStart(sf) + Math.max(0, removed),
			sourceEnd: start + node.end,
		});
	};
	const execute = (text: string, node: ts.Node) => {
		fm.executable += text + '\n';
		declare(text, node);
	};
	const unexported = (node: ts.Node) => node.getText(sf).replace(/^export\s+/, '');

	for (const n of sf.statements) {
		try {
			if (ts.isImportDeclaration(n)) await analyzeImport(ctx, fm, n, sf, execute);
			else if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n))
				declare(unexported(n), n);
			else if (ts.isVariableStatement(n) && n.declarationList.flags & ts.NodeFlags.Const) {
				for (const d of n.declarationList.declarations) {
					if (!ts.isIdentifier(d.name))
						throw new Error('Build-time constants require identifier names.');
					fm.constantNames.push(d.name.text);
				}
				execute(unexported(n), n);
			} else if (
				ts.isFunctionDeclaration(n) ||
				ts.isExpressionStatement(n) ||
				ts.isIfStatement(n) ||
				ts.isForStatement(n) ||
				ts.isForOfStatement(n) ||
				ts.isWhileStatement(n)
			)
				execute(n.getText(sf), n);
			else throw new Error('Unsupported frontmatter statement: ' + ts.SyntaxKind[n.kind]);
		} catch (e) {
			report(e, n);
		}
	}
	if (isFragment(ctx, fm, 'Fragment'))
		fm.prefix +=
			'declare function Fragment(props: { slot?: string; "set:html"?: string; children?: unknown }): JSX.Element;\n';

	const aliases = new Map<string, ts.TypeNode | ts.InterfaceDeclaration>();
	for (const n of sf.statements) {
		if (ts.isInterfaceDeclaration(n)) aliases.set(n.name.text, n);
		if (ts.isTypeAliasDeclaration(n)) aliases.set(n.name.text, n.type);
	}
	let resolveContract: ReturnType<typeof contractResolver> | undefined;
	for (const name of ['Props', 'Server'] as const) {
		const n = aliases.get(name);
		if (!n) {
			fm.prefix += `interface ${name} {}\n`;
			continue;
		}
		try {
			let schema: Contract;
			try {
				schema = ts.isInterfaceDeclaration(n)
					? interfaceContract(n, aliases)
					: contract(n, aliases);
			} catch (e) {
				if (!(e instanceof SyntaxOnlyContractError)) throw e;
				resolveContract ??= contractResolver(filename + '.ts', code);
				try {
					schema = resolveContract(name);
				} catch (resolvedError) {
					throw new Error(e.message + ' ' + (resolvedError as Error).message);
				}
			}
			result[name === 'Props' ? 'props' : 'server'] = schema;
			validateContract(name, schema);
		} catch (e) {
			report(e, n);
		}
	}
	fm.prefix += 'declare const props: Props; declare const server: Server;\n';
	fm.prefix += `declare const xph: { slots: { render(name: string, args?: unknown[]): string }; self: (props: Props & { slot?: string }) => JSX.Element };\n`;
	return fm;
}

/** `<Fragment>` is built in unless the component binds that name itself. */
export function isFragment(ctx: CompileContext, fm: Frontmatter, name: string) {
	return name === 'Fragment' && !ctx.result.imports[name] && !fm.constantNames.includes(name);
}

function validateContract(name: 'Props' | 'Server', schema: Contract) {
	if (schema.kind !== 'object') throw new Error(`${name} must be an object contract.`);
	if (name === 'Props' && hasFunction(schema))
		throw new Error('Functions are supported only as top-level Server methods.');
	if (schema.index && hasFunction(schema.index.value))
		throw new Error('Functions are supported only as top-level Server methods.');
	if (name === 'Server')
		for (const field of Object.values(schema.fields))
			if (field.type.kind === 'function' ? field.optional : hasFunction(field.type))
				throw new Error('Server methods must be required top-level fields.');
}

async function analyzeImport(
	ctx: CompileContext,
	fm: Frontmatter,
	n: ts.ImportDeclaration,
	sf: ts.SourceFile,
	execute: (text: string, node: ts.Node) => void,
) {
	const path = (n.moduleSpecifier as ts.StringLiteral).text;
	const clause = n.importClause;
	if (path.endsWith('.xph')) {
		const name = clause?.name?.text;
		if (!name || clause?.namedBindings)
			throw new Error('Component imports require a default binding.');
		ctx.result.imports[name] = path;
		(ctx.result.importSpans ??= {})[name] = {
			start: fm.start + n.getStart(sf),
			end: fm.start + n.end,
		};
		const target = ctx.options.components?.[name];
		const propsType = target ? contractTS(target.props) : '{}';
		const acceptsClass = target?.props.kind === 'object' && target.props.fields.class;
		const directiveProps = acceptsClass
			? `(${propsType} | (Omit<${propsType}, 'class'> & { class?: string; 'class:list': unknown })) & { 'class:list'?: unknown }`
			: propsType;
		fm.prefix += `declare function ${name}(props: (${directiveProps}) & { slot?: string }): JSX.Element;\n`;
	} else if (path.endsWith('.svg')) {
		const name = clause?.name?.text;
		if (!name || clause?.namedBindings || clause?.isTypeOnly)
			throw new Error('SVG imports require a default binding.');
		fm.svgImports.set(name, await readSvg(resolve(dirname(ctx.filename), path)));
		fm.prefix += `declare function ${name}(props: { [name: string]: unknown }): JSX.Element;\n`;
	} else if (path.endsWith('.css')) {
		if (clause) throw new Error('CSS imports must use side-effect syntax: import "./styles.css";');
		fm.cssImports.push(path);
	} else {
		if (!clause?.isTypeOnly) {
			if (clause?.name) fm.constantNames.push(clause.name.text);
			const bindings = clause?.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings)) fm.constantNames.push(bindings.name.text);
			if (bindings && ts.isNamedImports(bindings))
				for (const binding of bindings.elements)
					if (!binding.isTypeOnly) fm.constantNames.push(binding.name.text);
		}
		execute(n.getText(sf), n);
	}
}

async function readSvg(file: string): Promise<SvgImport> {
	const svgSource = await readFile(file, 'utf8');
	const parsed = await parseTemplate(svgSource);
	const root = parsed.ast.children.find((node) => isTemplateElement(node) && node.name === 'svg');
	if (!root || !isTemplateElement(root) || parsed.diagnostics.some((d) => d.severity === 'error'))
		throw new Error('SVG imports require a valid <svg> root.');
	const attributes = root.attributes.map((a) => {
		if (a.kind !== 'quoted' && a.kind !== 'empty')
			throw new Error('SVG attributes must be static.');
		return {
			name: a.name,
			code: phpLiteral(a.kind === 'empty' ? true : decodeHTMLAttribute(a.value)),
		};
	});
	const content = svgSource.slice(root.openingEnd, root.end).replace(/<\/svg\s*>\s*$/, '');
	return { attributes, content };
}

function contractTS(c: Contract): string {
	switch (c.kind) {
		case 'function':
			return `(${c.parameters.map((parameter) => `${parameter.name}: ${contractTS(parameter.type)}`).join(', ')}) => ${contractTS(c.returns)}`;
		case 'string':
		case 'number':
		case 'boolean':
		case 'null':
			return c.kind;
		case 'literal':
			return JSON.stringify(c.value);
		case 'array':
			return `(${contractTS(c.element)})[]`;
		case 'union':
			return c.types.map(contractTS).join(' | ');
		case 'object':
			return (
				'{' +
				(c.index ? `[key: ${c.index.key}]: ${contractTS(c.index.value)}; ` : '') +
				Object.entries(c.fields)
					.map(([k, v]) => `${JSON.stringify(k)}${v.optional ? '?' : ''}: ${contractTS(v.type)}`)
					.join('; ') +
				'}'
			);
	}
}
