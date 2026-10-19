import { parse } from '@astrojs/compiler-rs';

/** Normalize the Rust ESTree AST for the PHP compiler. Offsets are UTF-16. */
export async function parseTemplate(source: string) {
	const parsed = parse(source);
	function attribute(node: any) {
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
				value?.type === 'JSXExpressionContainer'
					? source.slice(value.start + 1, value.end - 1)
					: (value?.value ?? ''),
		};
	}
	function normalize(node: any): any {
		const span = { start: node.start, end: node.end };
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
				return { type: 'expression', ...span };
			case 'AstroComment':
				return { type: 'comment', value: node.value, ...span };
			case 'AstroDoctype':
				return { type: 'doctype', ...span };
			default:
				return { type: node.type, ...span };
		}
	}
	return {
		ast: normalize(parsed.ast),
		diagnostics: parsed.diagnostics,
		start: (node: any) => node.start ?? 0,
		end: (node: any) => node.end ?? 0,
	};
}
