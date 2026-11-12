import ts from 'typescript';
import { decodeHTMLAttribute } from 'entities';
import {
	isTemplateElement,
	tagName,
	templateChildren,
	type TemplateAttribute,
	type TemplateElement,
	type TemplateNode,
} from './astro.js';
import { phpLiteral } from './contracts.js';
import { ReportedError, type ExpressionInput, type Expressions } from './expressions.js';
import { isFragment, type Frontmatter } from './frontmatter.js';
import { expressionLength, type PHPBlock } from './source.js';
import type { Assets } from './styles.js';
import type { CompileContext } from './context.js';
import type { IR } from './types.js';

type Range = { start: number; end: number };
type Attribute = Extract<IR, { kind: 'element' }>['attributes'][number];
/** A JSX value lowered into a PHP closure, called where the markup is used as a value. */
export interface MarkupHelper {
	name: string;
	nodes: IR[];
	parameters: string[];
}
type TemplateKey = TemplateNode | TemplateAttribute;

/** Element attributes normalized from template or JSX syntax. `at` locates diagnostics. */
type AttributeInput<T> = Range & { at: T } & (
		| { kind: 'spread'; expression: ts.Expression }
		| { kind: 'expression'; name: string; expression: ts.Expression }
		| { kind: 'static'; name: string; value: string | true }
		| { kind: 'invalid'; name: string }
	);
interface ElementInput<T> {
	name: string;
	at: T;
	location: Range;
	attributes: AttributeInput<T>[];
	children: () => IR[];
	/** The tag-name expression of a dynamic element such as `<Tag>` or `<item.tag>`. */
	tag: () => ts.Expression;
}

const SIMPLE_NAME = /^[a-zA-Z_:][\w:.-]*$/;
const WHITESPACE_SENSITIVE = ['pre', 'textarea', 'script', 'style', 'listing', 'xmp', 'plaintext'];

/**
 * Collect every template expression, attribute expression and dynamic tag name so they can be
 * type-checked together in one virtual TypeScript file. `refs` maps each template node to its
 * index in `Expressions.nodes`.
 */
export function gatherExpressions(
	source: string,
	ast: TemplateNode,
	isDynamicTag: (name: string) => boolean,
) {
	const inputs: ExpressionInput[] = [];
	const refs = new Map<TemplateKey, number>();
	const input = (text: string, start: number, key?: TemplateKey) => {
		if (key) refs.set(key, inputs.length);
		inputs.push({ text, start });
	};
	function gather(n: TemplateNode) {
		if (n.type === 'frontmatter') return;
		if (n.type === 'expression') {
			const start = source.indexOf('{', n.start) + 1;
			// The expression cannot extend past its own `{...}` container.
			const length = expressionLength(source.slice(start, n.end)) ?? 0;
			input(source.slice(start, start + length), start, n);
			return;
		}
		if (!isTemplateElement(n)) {
			for (const c of templateChildren(n)) gather(c);
			return;
		}
		if (n.name === 'style' || n.name === 'script') return;
		for (const a of n.attributes)
			if (a.kind === 'expression' || a.kind === 'spread') {
				const start =
					a.kind === 'spread'
						? source.indexOf('...', a.start) + 3
						: source.indexOf('{', a.start) + 1;
				input(a.value, start, a);
			}
		if (n.type === 'component' && isDynamicTag(n.name)) input(n.name, n.start + 1, n);
		else if (n.type === 'component') {
			// Type-check component props as JSX. Keep the opening tag verbatim so every
			// attribute keeps its source offset.
			const opening = source.slice(n.start, n.openingEnd);
			input(
				opening.endsWith('/>')
					? opening
					: (opening.endsWith('>') ? opening.slice(0, -1) : opening) + ' />',
				n.start,
			);
		}
		for (const c of n.children) gather(c);
	}
	gather(ast);
	return { inputs, refs };
}

/** The render id of an imported component or `xph.self`; undefined for any other tag. */
function componentId(ctx: CompileContext, name: string) {
	const { result, options, filename } = ctx;
	if (name === 'xph.self') return options.scopeId ?? filename;
	return result.imports[name] ? (options.components?.[name]?.id ?? name) : undefined;
}
/** A capitalized or dotted tag that names a string value, such as `<Tag>` or `<item.tag>`. */
export function isDynamicTag(ctx: CompileContext, fm: Frontmatter, name: string) {
	return (
		componentId(ctx, name) === undefined && !isFragment(ctx, fm, name) && !fm.svgImports.has(name)
	);
}

/** Lower the template and its JSX expressions to the IR consumed by the PHP emitter. */
export class Lowering {
	readonly markupHelpers: MarkupHelper[] = [];
	private markupCache = new Map<ts.Node, string>();

	constructor(
		private ctx: CompileContext,
		private fm: Frontmatter,
		private expressions: Expressions,
		private assets: Assets,
		private refs: Map<TemplateKey, number>,
		private php: { masked: string; blocks: PHPBlock[] },
	) {
		expressions.jsxValue = (node) => this.markupValue(node);
	}

	private componentId(name: string) {
		return componentId(this.ctx, name);
	}
	private isComponent(name: string) {
		return this.componentId(name) !== undefined;
	}
	private isFragment(name: string) {
		return isFragment(this.ctx, this.fm, name);
	}

	/** A PHP literal whose value is known, so emission can serialize it statically. */
	constantCode(value: unknown) {
		const code = phpLiteral(value);
		this.expressions.staticValues.set(code, { value });
		return code;
	}

	private node(key: TemplateKey) {
		return this.expressions.nodes[this.refs.get(key)!];
	}

	lower(n: TemplateNode): IR[] {
		try {
			return this.lowerNode(n);
		} catch (e) {
			if (!(e instanceof Error)) throw e;
			if (!(e instanceof ReportedError)) this.ctx.error(e.message, n.start, n.end);
			return [];
		}
	}

	private lowerNode(n: TemplateNode): IR[] {
		const range = { start: n.start, end: Math.max(n.start + 1, n.end) };
		const inline = this.assets.inline.get(n);
		if (inline !== undefined) return [{ kind: 'text', value: inline, ...range }];
		const name = tagName(n);
		if (n.type === 'frontmatter' || name === 'style' || name === 'script') return [];
		switch (n.type) {
			case 'root': {
				const nodes = n.children.flatMap((c) => this.lower(c));
				while (nodes[0]?.kind === 'text' && !nodes[0].value.trim()) nodes.shift();
				return nodes;
			}
			case 'fragment':
				return n.children.flatMap((c) => this.lower(c));
			case 'text': {
				// Server-script placeholders are blanked in the masked source; drop their text.
				const { masked, blocks } = this.php;
				const value = blocks.reduce(
					(text, b) => text.replace(masked.slice(b.start, b.end), ''),
					n.value,
				);
				return [{ kind: 'text', value, ...range }];
			}
			case 'comment':
				if (this.php.blocks.some((b) => n.start >= b.start && n.start < b.end)) return [];
				return [{ kind: 'text', value: `<!--${n.value}-->`, ...range }];
			case 'doctype':
				return [{ kind: 'text', value: '<!DOCTYPE html>', ...range }];
			case 'empty-expression':
				return [];
			case 'expression':
				return this.expressionIR(this.node(n));
			case 'element':
			case 'component':
			case 'custom-element':
				return [this.templateElement(n)];
			case 'unknown':
				this.ctx.error('Unsupported template node ' + n.nodeType, n.start);
				return [];
		}
	}

	private templateElement(n: TemplateElement): IR {
		const { expressions } = this;
		const span = (node: Range) => ({ start: node.start, end: Math.max(node.start + 1, node.end) });
		const attributes = n.attributes.map((a): AttributeInput<Range> => {
			if (a.kind === 'spread') {
				const expression = this.node(a);
				return { kind: 'spread', expression, at: a, ...expressions.range(expression) };
			}
			if (a.kind === 'expression') {
				const expression = this.node(a);
				return {
					kind: 'expression',
					name: a.name,
					expression,
					at: a,
					...expressions.range(expression),
				};
			}
			if (a.kind === 'quoted' || a.kind === 'empty')
				return {
					kind: 'static',
					name: a.name,
					value: a.kind === 'empty' ? true : decodeHTMLAttribute(a.value),
					at: a,
					...span(a),
				};
			return { kind: 'invalid', name: a.name, at: a, ...span(a) };
		});
		return this.lowerElement(
			{
				name: n.name,
				at: n,
				location: span(n),
				attributes,
				children: () => n.children.flatMap((c) => this.lower(c)),
				tag: () => this.node(n),
			},
			// Template diagnostics are recoverable: report and keep lowering.
			(message, at) => this.ctx.error(message, at.start),
		);
	}

	private jsxElement(
		n: ts.JsxOpeningLikeElement,
		children: ts.NodeArray<ts.JsxChild> | ts.JsxChild[],
	): IR {
		const { expressions } = this;
		const name = n.tagName.getText();
		if (name === 'script' || name === 'style')
			return expressions.fail(n, 'Assets inside template expressions are unsupported.');
		const attributes = n.attributes.properties.map((a): AttributeInput<ts.Node> => {
			if (ts.isJsxSpreadAttribute(a))
				return {
					kind: 'spread',
					expression: a.expression,
					at: a,
					...expressions.range(a.expression),
				};
			const key = a.name.getText();
			if (!a.initializer)
				return { kind: 'static', name: key, value: true, at: a, ...expressions.range(a) };
			if (ts.isStringLiteral(a.initializer))
				return {
					kind: 'static',
					name: key,
					value: a.initializer.text,
					at: a,
					...expressions.range(a),
				};
			if (ts.isJsxExpression(a.initializer) && a.initializer.expression)
				return {
					kind: 'expression',
					name: key,
					expression: a.initializer.expression,
					at: a,
					...expressions.range(a.initializer.expression),
				};
			return { kind: 'invalid', name: key, at: a, ...expressions.range(a) };
		});
		return this.lowerElement(
			{
				name,
				at: n,
				location: expressions.range(n),
				attributes,
				children: () => children.flatMap((c) => this.jsxChild(c)),
				tag: () => n.tagName as ts.Expression,
			},
			// A JSX value is lowered as a whole: the first diagnostic aborts it.
			(message, at) => expressions.fail(at, message),
		);
	}

	/** Shared element rules for template markup and JSX values. */
	private lowerElement<T>(n: ElementInput<T>, report: (message: string, at: T) => void): IR {
		const component = this.isComponent(n.name);
		const attributes: Attribute[] = [];
		let html: string | undefined;
		let text: string | undefined;
		for (const a of n.attributes) {
			if (a.kind === 'spread') {
				attributes.push({ code: this.spread(a.expression, component), start: a.start, end: a.end });
				continue;
			}
			if (
				(a.name === 'slot' || (n.name === 'slot' && a.name === 'name')) &&
				!(a.kind === 'static' && typeof a.value === 'string' && a.value)
			)
				report('Slot names must be non-empty string literals.', a.at);
			if (!SIMPLE_NAME.test(a.name)) {
				report('Unsupported attribute.', a.at);
				continue;
			}
			if (/^on/i.test(a.name)) {
				report('Event-handler attributes are unsupported; use a browser script.', a.at);
				continue;
			}
			if (a.kind === 'invalid') {
				report('Unsupported attribute syntax.', a.at);
				continue;
			}
			const code =
				a.kind === 'static'
					? this.constantCode(a.value)
					: this.attributeCode(a.name, a.expression, component);
			if (a.name === 'set:html' || a.name === 'set:text') {
				if (component || n.name === 'slot') report(a.name + ' requires an HTML element.', a.at);
				if (html !== undefined || text !== undefined)
					report('Content directives cannot be combined.', a.at);
				if (a.name === 'set:html') html = code;
				else text = code;
			} else if (a.name.includes(':') && a.name !== 'class:list')
				report('Unsupported directive ' + a.name, a.at);
			else attributes.push({ name: a.name, code, start: a.start, end: a.end });
		}
		const children = n.children();
		if (n.name === 'slot') {
			if (attributes.some((a) => a.name !== 'name'))
				report('Slots only support a name attribute.', n.at);
			return {
				kind: 'slot',
				name: attributes.find((a) => a.name === 'name')?.code,
				children,
				...n.location,
			};
		}
		if (this.isFragment(n.name)) {
			if (html !== undefined && children.length) report('set:html cannot have children.', n.at);
			if (text !== undefined || attributes.some((a) => a.name !== 'slot'))
				report('Fragment only supports slot and set:html attributes.', n.at);
			return {
				kind: 'element',
				name: n.name,
				fragment: true,
				html,
				attributes,
				children,
				...n.location,
			};
		}
		const svg = this.fm.svgImports.get(n.name);
		if (svg) {
			const defaults =
				'[' + svg.attributes.map((a) => `${phpLiteral(a.name)} => ${a.code}`).join(', ') + ']';
			const element: IR = {
				kind: 'element',
				name: 'svg',
				attributes: [{ code: defaults }, ...attributes],
				children: [],
				html: phpLiteral(svg.content),
				...n.location,
			};
			if (this.assets.hasCSS) this.scopeAttributes(element.attributes);
			return element;
		}
		const tag =
			!component && (/^[A-Z]/.test(n.name) || n.name.includes('.'))
				? this.dynamicName(n.tag())
				: undefined;
		if ((html !== undefined || text !== undefined) && children.length)
			report((text !== undefined ? 'set:text' : 'set:html') + ' cannot have children.', n.at);
		if (this.assets.hasCSS) this.scopeAttributes(attributes);
		return {
			kind: 'element',
			name: n.name,
			tag,
			attributes,
			children: text !== undefined ? [{ kind: 'expression', code: text, ...n.location }] : children,
			html,
			component: this.componentId(n.name),
			...n.location,
		};
	}

	/** PHP for an attribute expression: class lists, style objects, component props, or scalars. */
	private attributeCode(name: string, expression: ts.Expression, component: boolean) {
		if (name === 'class:list') return this.classCode(expression);
		if (component) return this.expressions.emit(expression);
		if (name.toLowerCase() === 'style') return this.expressions.style(expression);
		return this.expressions.scalar(expression);
	}

	private expressionIR(n: ts.Expression): IR[] {
		const { expressions } = this;
		const { checker } = expressions;
		const r = expressions.range(n);
		if (ts.isParenthesizedExpression(n)) return this.expressionIR(n.expression);
		if (ts.isJsxFragment(n)) return n.children.flatMap((c) => this.jsxChild(c));
		if (ts.isJsxElement(n)) return [this.jsxElement(n.openingElement, n.children)];
		if (ts.isJsxSelfClosingElement(n)) return [this.jsxElement(n, [])];
		if (ts.isConditionalExpression(n))
			return [
				{
					kind: 'branch',
					test: expressions.condition(n.condition),
					yes: this.expressionIR(n.whenTrue),
					no: this.expressionIR(n.whenFalse),
					...r,
				},
			];
		if (
			ts.isBinaryExpression(n) &&
			(n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
				n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
		) {
			// `a && <b/>` renders the left operand's value when it short-circuits, so keep
			// it in a local: `if (truthy($v = a)) { <b/> } else { echo $v }`.
			const and = n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
			const value = '$__xph_logical_' + n.getStart();
			const test = '\\Xph\\truthy(' + value + ' = ' + expressions.emit(n.left) + ')';
			const constant = expressions.staticValue(n.left);
			if (constant) expressions.staticValues.set(test, { value: !!constant.value });
			const left: IR[] = [
				{ kind: 'expression', code: constant ? this.constantCode(constant.value) : value, ...r },
			];
			const right = this.expressionIR(n.right);
			return [{ kind: 'branch', test, yes: and ? right : left, no: and ? left : right, ...r }];
		}
		if (
			ts.isCallExpression(n) &&
			ts.isPropertyAccessExpression(n.expression) &&
			n.expression.name.text === 'map' &&
			checker.isArrayType(checker.getTypeAtLocation(n.expression.expression))
		) {
			const callback = n.arguments[0];
			if (
				n.arguments.length !== 1 ||
				!callback ||
				!ts.isArrowFunction(callback) ||
				ts.isBlock(callback.body) ||
				callback.parameters.length < 1 ||
				callback.parameters.length > 2 ||
				callback.parameters.some(
					(p) => !ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken,
				)
			)
				return expressions.fail(
					n,
					'map requires an expression arrow callback with one or two identifier parameters.',
				);
			return [
				{
					kind: 'loop',
					value: expressions.emit(n.expression.expression),
					item: expressions.parameterName(callback.parameters[0]),
					index: callback.parameters[1]
						? expressions.parameterName(callback.parameters[1])
						: undefined,
					children: this.expressionIR(callback.body),
					...r,
				},
			];
		}
		if (
			n.kind === ts.SyntaxKind.NullKeyword ||
			n.kind === ts.SyntaxKind.FalseKeyword ||
			n.kind === ts.SyntaxKind.TrueKeyword
		)
			return [];
		if (ts.isArrowFunction(n)) {
			if (
				ts.isBlock(n.body) ||
				n.typeParameters?.length ||
				n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ||
				n.parameters.some(
					(p) =>
						!ts.isIdentifier(p.name) ||
						!p.type ||
						p.initializer ||
						p.dotDotDotToken ||
						p.questionToken,
				)
			)
				return expressions.fail(
					n,
					'Slot callbacks require an expression body and explicitly typed identifier parameters.',
				);
			return [
				{
					kind: 'slot-callback',
					parameters: n.parameters.map((p) => expressions.parameterName(p)),
					children: this.expressionIR(n.body),
					...r,
				},
			];
		}
		return [{ kind: 'expression', code: expressions.scalar(n), ...r }];
	}

	private jsxChild(n: ts.JsxChild): IR[] {
		if (ts.isJsxText(n)) return [{ kind: 'text', value: n.text, ...this.expressions.range(n) }];
		if (ts.isJsxExpression(n)) return n.expression ? this.expressionIR(n.expression) : [];
		return this.expressionIR(n as ts.Expression);
	}

	/** Lower JSX used as a value (e.g. a prop) into a helper closure and return its call. */
	private markupValue(node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment) {
		const cached = this.markupCache.get(node);
		if (cached) return cached;
		const parameters: string[] = [];
		for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent)
			if (ts.isArrowFunction(parent))
				for (const parameter of parent.parameters)
					parameters.push(this.expressions.parameterName(parameter));
		const nodes = this.expressionIR(node);
		const name = '__xph_markup_' + this.markupHelpers.length;
		this.markupHelpers.push({ name, nodes, parameters });
		const call = `$${name}($props, $server, $slot${parameters.map((p) => ', $' + p).join('')})`;
		this.markupCache.set(node, call);
		return call;
	}

	private spread(node: ts.Expression, component: boolean): string {
		const { expressions } = this;
		const { checker } = expressions;
		const type = checker.getTypeAtLocation(node);
		for (const t of type.isUnion() ? type.types : [type]) {
			if (
				!(t.flags & ts.TypeFlags.Object) ||
				checker.isArrayType(t) ||
				checker.isTupleType(t) ||
				t.getCallSignatures().length
			)
				return expressions.fail(node, 'Spread attributes require an object.');
			if (component) continue;
			for (const property of t.getProperties()) {
				const name = property.getName();
				if (!/^[a-zA-Z_][\w.-]*$/.test(name) || /^on/i.test(name) || name === 'slot')
					return expressions.fail(node, 'Unsupported spread attribute ' + name);
				const value = checker.getTypeOfSymbolAtLocation(property, node);
				if (name.toLowerCase() === 'style') {
					expressions.styleType(value, node);
					continue;
				}
				const scalar =
					ts.TypeFlags.StringLike |
					ts.TypeFlags.NumberLike |
					ts.TypeFlags.BooleanLike |
					ts.TypeFlags.Null |
					ts.TypeFlags.Undefined;
				if ((value.isUnion() ? value.types : [value]).some((v) => !(v.flags & scalar)))
					return expressions.fail(
						node,
						'Only scalar values can be rendered as text or attributes.',
					);
			}
		}
		return expressions.emit(node);
	}

	private classCode(node: ts.Expression): string {
		const { expressions } = this;
		const { checker } = expressions;
		if (ts.isParenthesizedExpression(node)) return this.classCode(node.expression);
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
			return expressions.emit(node);
		if (expressions.foldConstants && typeof expressions.staticValue(node)?.value === 'string')
			return expressions.emit(node);
		if (ts.isArrayLiteralExpression(node))
			return (
				'\\Xph\\classList([' +
				node.elements.map((item) => this.classCode(item as ts.Expression)).join(', ') +
				'])'
			);
		if (ts.isConditionalExpression(node))
			return `(${expressions.condition(node.condition)} ? ${this.classCode(node.whenTrue)} : ${this.classCode(node.whenFalse)})`;
		// Objects map class names to conditions; arrays and scalars are class values.
		const type = checker.getTypeAtLocation(node);
		const types = type.isUnion() ? type.types : [type];
		const list = (t: ts.Type) => checker.isArrayType(t) || checker.isTupleType(t);
		const object =
			!types.some(list) && types.some((t) => !!(t.flags & ts.TypeFlags.Object) && !list(t));
		return `\\Xph\\classList(${expressions.emit(node)}, ${object ? 'true' : 'false'})`;
	}

	private scopeAttributes(attributes: Attribute[]) {
		const { strategy, scopeAttribute, scopeClass } = this.ctx;
		if (strategy === 'attribute') {
			attributes.push({ name: scopeAttribute, code: this.constantCode('') });
			return;
		}
		const classes = attributes.filter((a) => a.name === 'class');
		const baseClass = classes[0];
		const constant = baseClass && this.expressions.staticValues.get(baseClass.code);
		// A known class needs no props merge. Keep the other attributes visible to
		// static serialization, even when some of their values are dynamic.
		if (
			!attributes.some((a) => a.name === undefined || a.name === 'class:list') &&
			classes.length <= 1 &&
			(!baseClass || (constant && (constant.value == null || typeof constant.value === 'string')))
		) {
			const code = this.constantCode(
				constant?.value ? `${constant.value} ${scopeClass}` : scopeClass,
			);
			if (baseClass) baseClass.code = code;
			else attributes.push({ name: 'class', code });
			return;
		}
		attributes.splice(0, attributes.length, { code: attributeProps(attributes, scopeClass) });
	}

	private dynamicName(node: ts.Expression): string {
		if (!this.expressions.is(node, ts.TypeFlags.StringLike))
			return this.expressions.fail(node, 'Dynamic element names must have string type.');
		return this.expressions.emit(node);
	}
}

/** PHP for an attribute array: named groups and spreads merged in source order. */
export function attributeProps(attributes: Attribute[], scopedClass?: string): string {
	const groups: string[] = [];
	let named: string[] = [];
	const flush = () => {
		if (named.length) groups.push('[' + named.join(', ') + ']');
		named = [];
	};
	for (const a of attributes) {
		if (a.name === undefined) {
			flush();
			groups.push(a.code);
		} else named.push(phpLiteral(a.name) + ' => ' + a.code);
	}
	flush();
	const classList = attributes.some((a) => a.name === 'class:list');
	if (scopedClass !== undefined) {
		if (classList)
			return `\\Xph\\scopedClassProps(${phpLiteral(scopedClass)}, ${groups.join(', ')})`;
		return `\\Xph\\classProps(${[...groups, "['class:list' => " + phpLiteral(scopedClass) + ']'].join(', ')})`;
	}
	if (classList) return '\\Xph\\classProps(' + groups.join(', ') + ')';
	if (groups.length === 0) return '[]';
	if (groups.length === 1) return groups[0];
	return '\\Xph\\mergeProps(' + groups.join(', ') + ')';
}

/** Collapse whitespace in static text, except opaque text and whitespace-sensitive elements. */
export function compressWhitespace(nodes: IR[], opaque: Set<number>) {
	for (const node of nodes) {
		if (node.kind === 'text') {
			if (!opaque.has(node.start)) node.value = node.value.replace(/[\t\n\f\r ]+/g, ' ');
		} else if (node.kind === 'element') {
			// Dynamic tags may render whitespace-sensitive elements.
			if (node.tag || WHITESPACE_SENSITIVE.includes(node.name.toLowerCase())) continue;
			compressWhitespace(node.children, opaque);
		} else if (node.kind === 'branch') {
			compressWhitespace(node.yes, opaque);
			compressWhitespace(node.no, opaque);
		} else if (node.kind !== 'expression' && node.kind !== 'php')
			compressWhitespace(node.children, opaque);
	}
}

/** Slot assignments and callbacks are only meaningful as direct children of a component. */
export function validateSlots(
	nodes: IR[],
	error: (message: string, start: number) => void,
	parentComponent = false,
	callbackParent = parentComponent,
) {
	for (const node of nodes) {
		if (node.kind === 'element') {
			if (!parentComponent && node.attributes.some((a) => a.name === 'slot'))
				error('Slot assignments must be direct children of an imported component.', node.start);
			validateSlots(
				node.children,
				error,
				!!node.component,
				!!node.component || (parentComponent && !!node.fragment),
			);
		} else if (node.kind === 'slot-callback') {
			if (!callbackParent)
				error(
					'Slot callbacks must be direct children of a component or its slot Fragment.',
					node.start,
				);
			validateSlots(node.children, error);
		} else if (node.kind === 'branch') {
			validateSlots(node.yes, error);
			validateSlots(node.no, error);
		} else if (node.kind === 'loop' || node.kind === 'slot') validateSlots(node.children, error);
	}
}
