import { basename } from 'node:path';
import { phpDoc, phpLiteral } from './contracts.js';
import { attributeKind, escapeHTML, staticAttribute } from './static-html.js';
import { attributeProps, type MarkupHelper } from './lower.js';
import { lineAt, position, type PHPBlock } from './source.js';
import type { CompileContext } from './context.js';
import type { Expressions } from './expressions.js';
import type { IR } from './types.js';

type Range = { start: number; end: number };
type Location = [start: number, end: number, line: number, column: number];

const voids = new Set(
	'area base br col embed hr img input link meta param source track wbr'.split(' '),
);
const HELPER = /__xph_markup_\d+/g;

/** Markup helper names referenced by the PHP code inside `nodes`, at any depth. */
const helperReferences = (() => {
	const cache = new WeakMap<IR[], Set<string>>();
	return function references(nodes: IR[]): Set<string> {
		let found = cache.get(nodes);
		if (found) return found;
		found = new Set();
		const scan = (code: string | undefined) => {
			for (const match of code?.match(HELPER) ?? []) found!.add(match);
		};
		const visit = (list: IR[]) => {
			for (const n of list)
				switch (n.kind) {
					case 'expression':
					case 'php':
						scan(n.code);
						break;
					case 'branch':
						scan(n.test);
						visit(n.yes);
						visit(n.no);
						break;
					case 'loop':
						scan(n.value);
						visit(n.children);
						break;
					case 'slot':
						scan(n.name);
						visit(n.children);
						break;
					case 'element':
						for (const a of n.attributes) scan(a.code);
						scan(n.html);
						scan(n.tag);
						visit(n.children);
						break;
					case 'slot-callback':
						visit(n.children);
						break;
				}
		};
		visit(nodes);
		cache.set(nodes, found);
		return found;
	};
})();

/**
 * Emit the component's PHP: a closure returning rendered HTML. Static markup is written as
 * inline HTML outside `<?php` tags; dynamic parts echo through the runtime's escaping helpers.
 */
export function emitPHP(
	ctx: CompileContext,
	ir: IR[],
	markupHelpers: MarkupHelper[],
	expressions: Expressions,
	block: PHPBlock | undefined,
): string {
	const { source, options, debug, result, error } = ctx;
	const { staticValues } = expressions;
	let php = '<?php\ndeclare(strict_types=1);\n';
	// Compact tuples are expanded into named fields only when reporting a failure.
	const locations: Location[] = [];
	const locationIds = new Map<string, number>();
	const location = (range: Range): Location => {
		const at = position(source, range.start);
		return [range.start, range.end, at.line + 1, at.character + 1];
	};
	const component = options.scopeId ? options.scopeId + '.xph' : basename(ctx.filename);
	// Generated line (relative to $__xph_base) → server-script source location.
	const origins: Record<number, Location> = {};
	const isRenderless = (id: string) =>
		Object.values(options.components ?? {}).some((c) => c.id === id && c.renderless);

	const catchCode = () =>
		`} catch (\\Throwable $__xph_error) {\nwhile (ob_get_level() > $__xph_buffer) ob_end_clean();\n` +
		(debug
			? `if (\\Xph\\runtimeDiagnosticsEnabled()) {\n` +
				`\\Xph\\recordRuntimeError($__xph_error, ${phpLiteral(component)}, (${phpLiteral(locations)})[$__xph_location] ?? [], ` +
				`$__xph_error->getFile() === __FILE__ ? ((${phpLiteral(origins)})[$__xph_error->getLine() - $__xph_base] ?? null) : null);\n}\nthrow $__xph_error;\n}\n`
			: `throw new \\RuntimeException(${phpLiteral('Render failed for component ' + component)}, 0, $__xph_error);\n}\n`);
	const vars = (names: string[]) => names.map((name) => '$' + name).join(', ');
	/** Open a closure body that renders into its own output buffer. */
	const openBuffered = (signature: string) =>
		`${signature} {\n${debug ? '$__xph_location = -1;\n' : ''}$__xph_buffer = ob_get_level();\nob_start();\ntry {\n`;
	const closeBuffered = (terminator: string) =>
		'return ob_get_clean();\n' + catchCode() + '}' + terminator;

	let inPHP = true;
	let pendingMarkup: { text: string; range?: Range }[] = [];
	const flushMarkup = () => {
		if (!pendingMarkup.length) return;
		const text = pendingMarkup.map((part) => part.text).join('');
		// Keep PHP-looking content inert, including tokens formed across adjacent nodes.
		const quoted = text.includes('<?') || /^[\r\n]/.test(text);
		if (quoted && !inPHP) {
			php += '<?php ';
			inPHP = true;
		}
		if (!quoted && inPHP) {
			php += '?>';
			inPHP = false;
		}
		const generatedStart = php.length;
		php += quoted ? `echo ${phpLiteral(text)};\n` : text;
		let offset = generatedStart;
		for (const part of pendingMarkup) {
			if (part.range)
				result.mappings.push({
					generatedStart: quoted ? generatedStart : offset,
					generatedEnd: quoted ? php.length : offset + part.text.length,
					sourceStart: part.range.start,
					sourceEnd: part.range.end,
				});
			offset += part.text.length;
		}
		pendingMarkup = [];
	};
	/** Append PHP code; with a range, map it to the source and track it for runtime errors. */
	const append = (text: string, n?: Range, track = true) => {
		flushMarkup();
		if (!inPHP) {
			php += '<?php ';
			inPHP = true;
		}
		if (n && track && debug) {
			const key = `${n.start}:${n.end}`;
			let index = locationIds.get(key);
			if (index === undefined) {
				index = locations.length;
				locationIds.set(key, index);
				locations.push(location(n));
			}
			php += `$__xph_location = ${index};\n`;
		}
		const generatedStart = php.length;
		php += text;
		if (n)
			result.mappings.push({
				generatedStart,
				generatedEnd: php.length,
				sourceStart: n.start,
				sourceEnd: n.end,
			});
	};
	const doc = (text: string) => (options.compactPHP ? '' : text);
	const markup = (text: string, range?: Range) => {
		if (text) pendingMarkup.push({ text, range });
	};
	const lineCount = () => lineAt(php, php.length) + 1;

	append(
		doc(`/** @param ${phpDoc(result.props)} $props */\n`) +
			`return static function (array $props, callable|array|null $slot = null): string {\n` +
			doc(`/** @var ${phpDoc(result.props)} $props */\n`),
	);
	const baseLine = lineCount();
	append(
		(debug ? '$__xph_base = __LINE__;\n$__xph_location = -1;\n' : '') +
			'$__xph_buffer = ob_get_level();\ntry {\n',
	);
	if (block) {
		append(
			doc(`/** @param ${phpDoc(result.props)} $props\n * @return ${phpDoc(result.server)} */\n`) +
				`$run = static function (array $props): array {\n`,
		);
		// Mark the call outside the isolated PHP scope; PHP-body line mappings use __LINE__.
		const blockLocation = locations.length;
		locations.push(
			location({ start: block.contentStart, end: block.contentStart + block.code.length }),
		);
		const generatedLine = lineCount() - baseLine;
		let sourceOffset = block.contentStart;
		const blockPosition = position(source, block.contentStart);
		for (const [index, line] of block.code.split('\n').entries()) {
			origins[generatedLine + index] = [
				sourceOffset,
				sourceOffset + line.length,
				blockPosition.line + index + 1,
				index === 0 ? blockPosition.character + 1 : 1,
			];
			sourceOffset += line.length + 1;
		}
		// Keep native PHP byte-for-byte so syntax diagnostics retain their existing mapping.
		const generatedStart = php.length;
		append(block.code);
		result.mappings.push({
			generatedStart,
			generatedEnd: php.length,
			sourceStart: block.contentStart,
			sourceEnd: block.contentStart + block.code.length,
		});
		append(
			`\n};\n${debug ? `$__xph_location = ${blockLocation};\n` : ''}$server = $run($props);\n`,
		);
	} else append('$server = [];\n');
	append(doc(`/** @var ${phpDoc(result.server)} $server */\n`));
	append('ob_start();\n');

	// Serialize constant attributes at compile time, reporting unsafe values as diagnostics.
	const staticAttributes = new WeakMap<object, string>();
	const attributeKinds = new WeakMap<object, number>();
	function validateStaticAttributes(nodes: IR[]) {
		for (const n of nodes) {
			if (n.kind === 'element') {
				if (
					!n.component &&
					!n.tag &&
					!n.attributes.some((a) => a.name === undefined || a.name === 'class:list')
				) {
					for (const a of n.attributes) {
						const constant = staticValues.get(a.code);
						try {
							attributeKinds.set(a, attributeKind(a.name!));
							if (constant)
								staticAttributes.set(a, staticAttribute(a.name!, constant.value, n.name));
						} catch (e) {
							// Dynamic unsupported names retain the generic runtime rejection.
							if (constant) error((e as Error).message, a.start ?? n.start, a.end ?? n.end);
						}
					}
				}
				validateStaticAttributes(n.children);
			} else if (n.kind === 'branch') {
				validateStaticAttributes(n.yes);
				validateStaticAttributes(n.no);
			} else if (n.kind !== 'text' && n.kind !== 'expression' && n.kind !== 'php')
				validateStaticAttributes(n.children);
		}
	}
	validateStaticAttributes(ir);
	for (const helper of markupHelpers) validateStaticAttributes(helper.nodes);

	const activeMarkupHelpers: string[] = [];
	let tagIndex = 0;
	const hasWork = (nodes: IR[]): boolean =>
		nodes.some((node) => {
			if (node.kind === 'text') return node.value !== '';
			if (node.kind === 'expression' && staticValues.has(node.code))
				return escapeHTML(staticValues.get(node.code)!.value) !== '';
			if (node.kind === 'element' && node.fragment && node.html === undefined)
				return hasWork(node.children);
			return true;
		});

	function emitComponent(n: Extract<IR, { kind: 'element' }>, activeVars: string[]) {
		if (!n.attributes.length && !n.children.length && isRenderless(n.component!)) return;
		// Group children by slot name; an unnamed Fragment contributes its children directly.
		const groups = new Map<string, IR[]>();
		for (const child of n.children) {
			const assignment =
				child.kind === 'element' ? child.attributes.find((a) => a.name === 'slot') : undefined;
			const key = assignment?.code ?? "'default'";
			const children = groups.get(key) ?? [];
			const content =
				child.kind === 'element'
					? { ...child, attributes: child.attributes.filter((a) => a.name !== 'slot') }
					: child;
			children.push(
				...(content.kind === 'element' && content.fragment && content.html === undefined
					? content.children
					: [content]),
			);
			groups.set(key, children);
		}
		append(
			`echo \\Xph\\render(${phpLiteral(n.component)}, ${attributeProps(n.attributes)}${groups.size ? ', [\n' : ''}`,
			n,
		);
		for (const [key, children] of groups) {
			const callbacks = children.filter((c) => c.kind === 'slot-callback');
			if (
				callbacks.length &&
				(callbacks.length !== 1 ||
					children.some(
						(c) => c.kind !== 'slot-callback' && !(c.kind === 'text' && !c.value.trim()),
					))
			) {
				error('A slot callback cannot be combined with other content in the same slot.', n.start);
				continue;
			}
			const callback = callbacks[0]?.kind === 'slot-callback' ? callbacks[0] : undefined;
			const parameters = callback?.parameters ?? [];
			const references = helperReferences(children);
			const uses = [
				'props',
				'server',
				'slot',
				...(debug ? ['__xph_base'] : []),
				...activeMarkupHelpers.filter((name) => references.has(name)),
				...new Set(activeVars),
			];
			append(openBuffered(`${key} => static function (${vars(parameters)}) use (${vars(uses)})`));
			emit(callback ? callback.children : children, [...activeVars, ...parameters]);
			append(closeBuffered(',\n'));
		}
		append(groups.size ? ']);\n' : ');\n');
	}

	function emitElement(n: Extract<IR, { kind: 'element' }>, activeVars: string[]) {
		const tag = n.tag ? '$__xph_tag_' + tagIndex++ : undefined;
		if (tag) {
			append(`${tag} = \\Xph\\elementName(${n.tag});\n`, n);
			append(`echo '<' . ${tag};\n`, n, false);
		} else markup('<' + n.name, n);
		const element = tag ?? phpLiteral(n.name);
		if (n.attributes.some((a) => a.name === undefined || a.name === 'class:list'))
			append(`echo \\Xph\\attributes(${attributeProps(n.attributes)}, ${element});\n`, n);
		else
			for (const a of n.attributes) {
				if (staticAttributes.has(a)) markup(staticAttributes.get(a)!, n);
				else
					append(
						tag || !attributeKinds.has(a)
							? `echo \\Xph\\attribute(${phpLiteral(a.name!)}, ${a.code}, ${element});\n`
							: `echo \\Xph\\attributeValue(${phpLiteral(a.name!)}, ${a.code}, ${attributeKinds.get(a)}, ${element});\n`,
						a.start !== undefined && a.end !== undefined ? { start: a.start, end: a.end } : n,
					);
			}
		markup('>');
		if (n.html) append(`echo \\Xph\\raw(${n.html});\n`, n);
		else emit(n.children, activeVars);
		if (tag)
			append(
				`if (!in_array(strtolower(${tag}), ${phpLiteral([...voids])}, true)) { echo '</' . ${tag} . '>'; }\n`,
			);
		else if (!voids.has(n.name)) markup('</' + n.name + '>');
	}

	function emit(nodes: IR[], activeVars: string[] = []) {
		for (const n of nodes) {
			switch (n.kind) {
				case 'text':
					markup(n.value, n);
					break;
				case 'expression':
					if (staticValues.has(n.code)) markup(escapeHTML(staticValues.get(n.code)!.value), n);
					else append(`echo \\Xph\\escape(${n.code});\n`, n);
					break;
				case 'branch':
					if (staticValues.has(n.test)) {
						emit(staticValues.get(n.test)!.value ? n.yes : n.no, activeVars);
						break;
					}
					append(`if (${n.test}) {\n`, n);
					emit(n.yes, activeVars);
					if (hasWork(n.no)) {
						append('} else {\n');
						emit(n.no, activeVars);
					}
					append('}\n');
					break;
				case 'loop':
					append(
						`foreach (${n.value} as ${n.index ? '$' + n.index + ' => ' : ''}$${n.item}) {\n`,
						n,
					);
					emit(n.children, [...activeVars, n.item, ...(n.index ? [n.index] : [])]);
					append('}\n');
					break;
				case 'slot': {
					const outlet = n.name
						? `(is_array($slot) && !is_callable($slot) ? ($slot[${n.name}] ?? null) : null)`
						: `(is_array($slot) && !is_callable($slot) ? ($slot['default'] ?? null) : $slot)`;
					append(`if (${outlet} !== null) { echo (${outlet})(); }`, n);
					if (hasWork(n.children)) {
						append(' else {\n');
						emit(n.children, activeVars);
						append('}');
					}
					append('\n');
					break;
				}
				case 'php':
					append(n.code + '\n', n);
					break;
				case 'element':
					if (n.fragment) {
						if (n.html !== undefined) append(`echo \\Xph\\raw(${n.html});\n`, n);
						else emit(n.children, activeVars);
					} else if (n.component) emitComponent(n, activeVars);
					else emitElement(n, activeVars);
					break;
			}
		}
	}

	// Define reachable helpers before the template, dependencies first, so closures can capture them.
	const ordered: MarkupHelper[] = [];
	const visited = new Set<string>();
	const visitHelper = (name: string) => {
		if (visited.has(name)) return;
		visited.add(name);
		const helper = markupHelpers.find((v) => v.name === name);
		if (!helper) return;
		for (const dependency of helperReferences(helper.nodes)) visitHelper(dependency);
		ordered.push(helper);
	};
	for (const name of helperReferences(ir)) visitHelper(name);
	for (const helper of ordered) {
		const references = helperReferences(helper.nodes);
		const captures = [
			...activeMarkupHelpers.filter((name) => references.has(name)),
			...(debug ? ['__xph_base'] : []),
		];
		append(
			openBuffered(
				`$${helper.name} = static function (${vars(['props', 'server', 'slot', ...helper.parameters])})${captures.length ? ' use (' + vars(captures) + ')' : ''}: string`,
			),
		);
		emit(helper.nodes, helper.parameters);
		append(closeBuffered(';\n'));
		activeMarkupHelpers.push(helper.name);
	}
	emit(ir);
	append(closeBuffered(';\n'));
	return php;
}

/** A component that renders nothing, so callers can skip loading and calling it. */
export function isInert(nodes: IR[], options: CompileContext['options']): boolean {
	return nodes.every((n) => {
		if (n.kind === 'text') return n.value === '';
		if (n.kind !== 'element' || n.html !== undefined || n.tag) return false;
		if (n.fragment) return isInert(n.children, options);
		return (
			!!n.component &&
			!n.attributes.length &&
			!n.children.length &&
			Object.values(options.components ?? {}).some((c) => c.id === n.component && c.renderless)
		);
	});
}
