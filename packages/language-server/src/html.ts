import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import {
	getLanguageService,
	newHTMLDataProvider,
	getDefaultHTMLDataProvider,
	type Location,
} from 'vscode-html-languageservice';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { extractPHP, type IR, type Mapping } from 'xph';

const nativeHTML = getDefaultHTMLDataProvider();
const nativeTags = new Set(nativeHTML.provideTags().map((tag) => tag.name));

type NativeDefinition = { location: Location; attributes: Map<string, Location> };
// Installed declarations are immutable for the lifetime of the server.
// Cache locations for both tags and attributes without retaining the syntax tree.
let nativeDefinitions: Map<string, NativeDefinition> | undefined;

function loadNativeDefinitions(): Map<string, NativeDefinition> {
	const definitions = new Map<string, NativeDefinition>();
	const url = new URL('./xph.d.ts', import.meta.url);
	const source = ts.sys.readFile(fileURLToPath(url));
	if (source === undefined) return definitions;
	const file = ts.createSourceFile('xph.d.ts', source, ts.ScriptTarget.Latest, true);
	const document = TextDocument.create(url.href, 'typescript', 0, source);
	const interfaces = new Map(
		file.statements.filter(ts.isInterfaceDeclaration).map((node) => [node.name.text, node]),
	);
	const location = (name: ts.PropertyName): Location => ({
		uri: document.uri,
		range: {
			start: document.positionAt(name.getStart(file) + (ts.isStringLiteral(name) ? 1 : 0)),
			end: document.positionAt(name.end - (ts.isStringLiteral(name) ? 1 : 0)),
		},
	});
	const attributes = (members: ts.NodeArray<ts.TypeElement> | undefined) => {
		const result = new Map<string, Location>();
		for (const member of members ?? []) {
			if (
				ts.isPropertySignature(member) &&
				(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
			)
				result.set(member.name.text, location(member.name));
		}
		return result;
	};
	const globals = attributes(interfaces.get('HTMLAttributes')?.members);
	for (const [namespace, name] of [
		['html', 'Elements'],
		['svg', 'SVGElements'],
	]) {
		for (const member of interfaces.get(name)?.members ?? []) {
			if (
				!ts.isPropertySignature(member) ||
				!(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ||
				!member.type ||
				!ts.isIntersectionTypeNode(member.type)
			)
				continue;
			const local = attributes(member.type.types.find(ts.isTypeLiteralNode)?.members);
			definitions.set(`${namespace}:${member.name.text}`, {
				location: location(member.name),
				attributes: new Map([...globals, ...local]),
			});
		}
	}
	return definitions;
}

function nativeDefinition(tag: string, namespace: string) {
	if (namespace === 'math') return;
	nativeDefinitions ??= loadNativeDefinitions();
	return nativeDefinitions.get(`${namespace === 'svg' ? 'svg' : 'html'}:${tag}`);
}

export function nativeAttributeDefinition(tag: string, attribute: string) {
	if (/^on/i.test(attribute)) return null;
	return nativeDefinition(tag, 'html')?.attributes.get(attribute) ?? null;
}

export function nativeTagDefinition(tag: string, namespace = 'html') {
	return nativeDefinition(tag, namespace)?.location ?? null;
}

export const htmlService = getLanguageService({
	customDataProviders: [
		newHTMLDataProvider('xph', {
			version: 1.1,
			globalAttributes: [
				{
					name: 'class:list',
					description: 'Combine class strings, arrays and conditional objects.',
				},
				{ name: 'set:html', description: 'Render raw HTML without escaping.' },
				{ name: 'set:text', description: 'Render escaped text instead of children.' },
			],
		}),
	],
});

export function htmlContext(uri: string, source: string, offset: number) {
	const frontmatter = /^---[^\S\r\n]*\r?\n[\s\S]*?^---[^\S\r\n]*(?:\r?\n|$)/m.exec(source);
	const frontEnd = frontmatter?.index === 0 ? frontmatter[0].length : 0;
	const masked =
		source.slice(0, frontEnd).replace(/[^\r\n]/g, ' ') + extractPHP(source).masked.slice(frontEnd);
	const document = TextDocument.create(uri, 'html', 0, masked);
	const html = htmlService.parseHTMLDocument(document);
	const node = html.findNodeBefore(offset);
	const tag = /^<([\w.:-]+)/.exec(source.slice(node.start))?.[1];
	if (offset < frontEnd || !tag || offset > (node.startTagEnd ?? node.end)) return;
	// HTML does not understand JSX expression delimiters. Leave attribute expressions
	// to TypeScript, including strings and comments containing braces or angle brackets.
	let braces = 0;
	let quote = '';
	let comment = '';
	for (let i = node.start + tag.length + 1; i < offset; i++) {
		const c = source[i];
		const next = source[i + 1];
		if (comment) {
			if (comment === '//' && c === '\n') comment = '';
			else if (comment === '/*' && c === '*' && next === '/') {
				comment = '';
				i++;
			}
		} else if (quote) {
			if (c === '\\') i++;
			else if (c === quote) quote = '';
		} else if (braces && c === '/' && (next === '/' || next === '*')) {
			comment = c + next;
			i++;
		} else if (c === '"' || c === "'" || (braces && c === '`')) quote = c;
		else if (c === '{') braces++;
		else if (c === '}') braces--;
	}
	return { document, html, node, tag, expression: braces > 0 };
}

// Check native attributes against the shared declarations while preserving expression scopes.
// Keep these editor-only declarations and source mappings out of PHP compilation.
export function htmlVirtual(
	source: string,
	nodes: IR[],
	virtual: { code: string; mappings: Mapping[] },
) {
	// Contextually type standalone style expressions in their original lexical scope.
	const declarationsPath = JSON.stringify(fileURLToPath(new URL('./xph.js', import.meta.url)));
	const insertions = new Map<number, string>();
	function styles(nodes: IR[]) {
		for (const node of nodes) {
			if (node.kind === 'element' && !node.component)
				for (const attribute of node.attributes) {
					if (attribute.name?.toLowerCase() !== 'style' || attribute.start === undefined) continue;
					const mapping = virtual.mappings.find(
						(m) => m.sourceStart === attribute.start && m.sourceEnd === attribute.end,
					);
					if (!mapping) continue;
					const match = /const __xph\d+( = \()$/.exec(
						virtual.code.slice(0, mapping.generatedStart),
					);
					if (match)
						insertions.set(
							mapping.generatedStart - match[1].length,
							`: string | import(${declarationsPath}).CSSProperties | null | undefined`,
						);
				}
			if ('children' in node) styles(node.children);
			if (node.kind === 'branch') {
				styles(node.yes);
				styles(node.no);
			}
		}
	}
	styles(nodes);
	for (const [offset, text] of [...insertions].sort(([a], [b]) => b - a)) {
		virtual.code = virtual.code.slice(0, offset) + text + virtual.code.slice(offset);
		for (const mapping of virtual.mappings) {
			if (mapping.generatedStart >= offset) mapping.generatedStart += text.length;
			if (mapping.generatedEnd >= offset) mapping.generatedEnd += text.length;
		}
	}
	const generatedOffset = virtual.code.length;
	let code = '\n';
	const mappings: Mapping[] = [];
	const tags = new Set<string>();
	function visit(nodes: IR[], foreign = false) {
		for (const node of nodes) {
			if (node.kind === 'branch') {
				visit([...node.yes, ...node.no], foreign);
				continue;
			}
			if (node.kind !== 'element') {
				if ('children' in node) visit(node.children, foreign);
				continue;
			}
			const nestedForeign = foreign || node.name === 'svg' || node.name === 'math';
			visit(node.children, nestedForeign);
			if (
				nestedForeign ||
				node.component ||
				node.fragment ||
				node.tag ||
				!nativeTags.has(node.name)
			)
				continue;
			const prefix = 'const __ = (';
			const file = ts.createSourceFile(
				'attributes.tsx',
				prefix + source.slice(node.start, node.end) + ');',
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TSX,
			);
			const declaration = (file.statements[0] as ts.VariableStatement)?.declarationList
				?.declarations[0];
			const expression = declaration?.initializer;
			const jsx =
				expression && ts.isParenthesizedExpression(expression) ? expression.expression : expression;
			const opening =
				jsx && ts.isJsxElement(jsx)
					? jsx.openingElement
					: jsx && ts.isJsxSelfClosingElement(jsx)
						? jsx
						: undefined;
			if (!opening || !opening.attributes.properties.length) continue;
			tags.add(node.name);
			const preserved = virtual.mappings.find(
				(mapping) =>
					node.start >= mapping.sourceStart &&
					node.start + opening.end - prefix.length <= mapping.sourceEnd,
			);
			const addMapping = (
				start: number,
				end: number,
				generatedStart: number,
				generatedEnd: number,
			) => {
				mappings.push({ sourceStart: start, sourceEnd: end, generatedStart, generatedEnd });
			};
			if (!preserved) {
				code += '(<';
				const generatedStart = generatedOffset + code.length;
				code += node.name;
				addMapping(
					node.start + 1,
					node.start + 1 + node.name.length,
					generatedStart,
					generatedOffset + code.length,
				);
			} else {
				const generatedStart = preserved.generatedStart + node.start + 1 - preserved.sourceStart;
				addMapping(
					node.start + 1,
					node.start + 1 + node.name.length,
					generatedStart,
					generatedStart + node.name.length,
				);
			}
			for (const attribute of opening.attributes.properties) {
				const start = node.start + attribute.getStart(file) - prefix.length;
				const end = node.start + attribute.end - prefix.length;
				if (preserved) {
					const generatedStart = preserved.generatedStart + start - preserved.sourceStart;
					addMapping(start, end, generatedStart, generatedStart + end - start);
					continue;
				}
				code += ' ';
				const generatedStart = generatedOffset + code.length;
				let text = attribute.getText(file);
				const expression = ts.isJsxSpreadAttribute(attribute)
					? attribute.expression
					: attribute.initializer && ts.isJsxExpression(attribute.initializer)
						? attribute.initializer.expression
						: undefined;
				if (expression) {
					const expressionStart = node.start + expression.getStart(file) - prefix.length;
					const expressionEnd = node.start + expression.end - prefix.length;
					const mapping = virtual.mappings.find(
						(mapping) =>
							expressionStart >= mapping.sourceStart && expressionEnd <= mapping.sourceEnd,
					);
					const alias =
						mapping &&
						/const (__xph\d+)(?::[^\n]+)? = \($/.exec(
							virtual.code.slice(0, mapping.generatedStart),
						)?.[1];
					// Standalone attribute expressions already have typed variables in the compiler's virtual file.
					// Reuse them instead of moving expressions out of their original lexical scope.
					text = ts.isJsxSpreadAttribute(attribute)
						? `{...${alias ?? '(undefined as any)'}}`
						: `${attribute.name.getText(file)}={${alias ?? '(undefined as any)'}}`;
				}
				code += text;
				addMapping(start, end, generatedStart, generatedOffset + code.length);
			}
			if (preserved) continue;
			code += ' />);\n';
		}
	}
	visit(nodes);
	const declarations = fileURLToPath(new URL('./xph.js', import.meta.url));
	code += `import type { Elements as __XphElements } from ${JSON.stringify(declarations)};\n`;
	code += 'declare global { namespace JSX { interface IntrinsicElements {\n';
	for (const tag of tags) {
		code += `${JSON.stringify(tag)}: __XphElements[${JSON.stringify(tag)}] & { "class:list"?: unknown; "set:html"?: unknown; "set:text"?: unknown };\n`;
	}
	code += '} } }\n';
	return { code, mappings };
}
