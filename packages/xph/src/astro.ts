import { parse, type DiagnosticMessage } from '@astrojs/compiler-rs';

interface Span {
	start: number;
	end: number;
}
export interface TemplateAttribute extends Span {
	name: string;
	kind: 'spread' | 'empty' | 'shorthand' | 'expression' | 'template-literal' | 'quoted';
	/** Expression source for expressions and spreads; raw text for quoted values. */
	value: string;
}
export interface TemplateRoot extends Span {
	type: 'root';
	children: TemplateNode[];
}
export interface TemplateElement extends Span {
	type: 'element' | 'component' | 'custom-element';
	name: string;
	openingEnd: number;
	attributes: TemplateAttribute[];
	children: TemplateNode[];
}
export type TemplateNode =
	| TemplateElement
	| TemplateRoot
	| (Span & { type: 'fragment'; children: TemplateNode[] })
	| (Span & { type: 'frontmatter' | 'text' | 'comment'; value: string })
	| (Span & { type: 'expression' | 'empty-expression' | 'doctype' })
	/** A parser node the compiler does not support; `nodeType` is the parser's name. */
	| (Span & { type: 'unknown'; nodeType: string });

export const isTemplateElement = (node: TemplateNode): node is TemplateElement =>
	node.type === 'element' || node.type === 'component' || node.type === 'custom-element';
export const templateChildren = (node: TemplateNode): TemplateNode[] =>
	'children' in node ? node.children : [];
/** The tag name of an element node, so callers can test `script`/`style` on any node. */
export const tagName = (node: TemplateNode) => (isTemplateElement(node) ? node.name : undefined);

/** Normalize the Rust ESTree AST for the PHP compiler. Offsets are UTF-16. */
export async function parseTemplate(
	source: string,
): Promise<{ ast: TemplateRoot; diagnostics: DiagnosticMessage[] }> {
	const parsed = parse(source);
	// The Rust parser's ESTree nodes are untyped JSON; this adapter is the one place that reads them.
	function attribute(node: any): TemplateAttribute {
		const value = node.value;
		return {
			start: node.start,
			end: node.end,
			name: node.name ? source.slice(node.name.start, node.name.end) : '',
			kind:
				node.type === 'JSXSpreadAttribute'
					? 'spread'
					: !value
						? 'empty'
						: source[node.start] === '{'
							? 'shorthand'
							: value.type === 'JSXExpressionContainer'
								? source[value.start] === '{'
									? 'expression'
									: 'template-literal'
								: 'quoted',
			value:
				node.type === 'JSXSpreadAttribute'
					? source.slice(source.indexOf('...', node.start) + 3, node.end - 1)
					: value?.type === 'JSXExpressionContainer'
						? source.slice(value.start + 1, value.end - 1)
						: (value?.value ?? ''),
		};
	}
	function normalize(node: any): TemplateNode {
		const span = { start: node.start ?? 0, end: node.end ?? 0 };
		switch (node.type) {
			case 'AstroRoot':
				return {
					type: 'root',
					...span,
					children: [
						...(node.frontmatter.end > 0
							? [
									{
										type: 'frontmatter',
										start: node.frontmatter.start,
										end: node.frontmatter.end,
										value: source.slice(3, node.frontmatter.end - 3),
									},
								]
							: []),
						...node.body.map(normalize),
					],
				};
			case 'JSXElement': {
				const opening = node.openingElement;
				const name = source.slice(opening.name.start, opening.name.end);
				return {
					type:
						/^[A-Z]/.test(name) || name.includes('.')
							? 'component'
							: name.includes('-')
								? 'custom-element'
								: 'element',
					name,
					openingEnd: opening.end,
					...span,
					attributes: opening.attributes.map(attribute),
					children:
						name === 'script' && !opening.selfClosing
							? [
									{
										type: 'text',
										value: source.slice(opening.end, node.closingElement.start),
										start: opening.end,
										end: node.closingElement.start,
									},
								]
							: node.children.map(normalize),
				};
			}
			case 'JSXFragment':
				return { type: 'fragment', ...span, children: node.children.map(normalize) };
			case 'JSXText':
				return { type: 'text', value: node.value, ...span };
			case 'JSXExpressionContainer':
				if (node.expression.type === 'JSXEmptyExpression')
					return { type: 'empty-expression', ...span };
				return { type: 'expression', ...span };
			case 'AstroComment':
				return { type: 'comment', value: node.value, ...span };
			case 'AstroDoctype':
				return { type: 'doctype', ...span };
			default:
				return { type: 'unknown', nodeType: node.type, ...span };
		}
	}
	// The root's normalization above always produces a 'root' node.
	return { ast: normalize(parsed.ast) as TemplateRoot, diagnostics: parsed.diagnostics };
}
