import { createRequire } from 'node:module';
import { checkBrowser } from './typescript.js';
import { decodeHTMLAttribute } from 'entities';
import { parseTemplate } from './astro.js';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { build as bundle } from 'esbuild';
import { basename, dirname, resolve } from 'node:path';
import vm from 'node:vm';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { contractResolver } from './resolved-contracts.js';
import { extractPHP, position } from './source.js';
import {
	contract,
	emptyContract,
	interfaceContract,
	phpDoc,
	phpLiteral,
	hasFunction,
} from './contracts.js';
import { Expressions, type ExpressionInput } from './expressions.js';
import type { CompileOptions, CompileResult, Contract, Diagnostic, IR, Mapping } from './types.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const voids = new Set(
	'area base br col embed hr img input link meta param source track wbr'.split(' '),
);
export async function compile(
	source: string,
	options: CompileOptions = {},
): Promise<CompileResult> {
	const filename = resolve(options.filename ?? 'component.xph'),
		id = hash(options.scopeId ?? filename),
		scope = `data-xph-${id}`;
	const extracted = extractPHP(source),
		diagnostics: Diagnostic[] = [...extracted.diagnostics];
	const result: CompileResult = {
		php: '',
		diagnostics,
		mappings: [],
		virtual: { code: '', mappings: [] },
		assets: [],
		imports: {},
		props: emptyContract,
		server: emptyContract,
		ir: [],
	};
	const error = (message: string, start = 0, end = start + 1) =>
		diagnostics.push({ message, severity: 'error', source: 'xph', start, end });
	let ast: any,
		start: (node: any) => number = () => 0,
		end: (node: any) => number = () => 0;
	try {
		const parsed = await parseTemplate(extracted.masked);
		ast = parsed.ast;
		start = parsed.start;
		end = parsed.end;
		for (const d of parsed.diagnostics) {
			const label = d.labels?.[0];
			diagnostics.push({
				message: d.text,
				severity: d.severity === 'error' ? 'error' : 'warning',
				source: 'xph',
				start: label?.start ?? 0,
				end: label?.end ?? 1,
			});
		}
		if (diagnostics.some((d) => d.severity === 'error')) return result;
	} catch (e) {
		error(String(e));
		return result;
	}
	const front = ast.children.find((n: any) => n.type === 'frontmatter');
	const frontCode: string = front?.value ?? '';
	const frontStart = front ? source.indexOf(frontCode, 3) : 0;
	const sf = ts.createSourceFile(
		filename + '.ts',
		frontCode,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const aliases = new Map<string, ts.TypeNode | ts.InterfaceDeclaration>();
	for (const n of sf.statements) {
		if (ts.isInterfaceDeclaration(n)) aliases.set(n.name.text, n);
		if (ts.isTypeAliasDeclaration(n)) aliases.set(n.name.text, n.type);
	}
	let prefix = `export {};\ndeclare global { namespace JSX { interface Element {} type ElementType = string | ((props: any) => Element); interface IntrinsicElements { [name: string]: any } } }\n`;
	const prefixMappings: Mapping[] = [];
	const addFrontmatter = (text: string, node: ts.Node) => {
		const generatedStart = prefix.length;
		prefix += text + '\n';
		const raw = node.getText(sf);
		const removed = raw.length - text.length;
		prefixMappings.push({
			generatedStart,
			generatedEnd: prefix.length - 1,
			sourceStart: frontStart + node.getStart(sf) + Math.max(0, removed),
			sourceEnd: frontStart + node.end,
		});
	};
	let executable = '',
		constantNames: string[] = [];
	for (const n of sf.statements) {
		try {
			if (ts.isImportDeclaration(n)) {
				const path = (n.moduleSpecifier as ts.StringLiteral).text;
				if (path.endsWith('.xph')) {
					const name = n.importClause?.name?.text;
					if (!name || n.importClause?.namedBindings)
						throw new Error('Component imports require a default binding.');
					result.imports[name] = path;
					const target = options.components?.[name];
					const propsType = target ? contractTS(target.props) : '{}';
					const acceptsClass = target?.props.kind === 'object' && target.props.fields.class;
					const directiveProps = acceptsClass
						? `(${propsType} | (Omit<${propsType}, 'class'> & { class?: string; 'class:list': unknown })) & { 'class:list'?: unknown }`
						: propsType;
					prefix += `declare function ${name}(props: ${directiveProps}): JSX.Element;\n`;
				} else {
					if (!n.importClause?.isTypeOnly) {
						if (n.importClause?.name) constantNames.push(n.importClause.name.text);
						const bindings = n.importClause?.namedBindings;
						if (bindings && ts.isNamespaceImport(bindings)) constantNames.push(bindings.name.text);
						if (bindings && ts.isNamedImports(bindings))
							for (const binding of bindings.elements)
								if (!binding.isTypeOnly) constantNames.push(binding.name.text);
					}
					executable += n.getText(sf) + '\n';
					addFrontmatter(n.getText(sf), n);
				}
			} else if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) {
				addFrontmatter(n.getText(sf).replace(/^export\s+/, ''), n);
			} else if (ts.isVariableStatement(n) && n.declarationList.flags & ts.NodeFlags.Const) {
				for (const d of n.declarationList.declarations) {
					if (!ts.isIdentifier(d.name))
						throw new Error('Build-time constants require identifier names.');
					constantNames.push(d.name.text);
				}
				executable += n.getText(sf).replace(/^export\s+/, '') + '\n';
				addFrontmatter(n.getText(sf).replace(/^export\s+/, ''), n);
			} else if (
				ts.isFunctionDeclaration(n) ||
				ts.isExpressionStatement(n) ||
				ts.isIfStatement(n) ||
				ts.isForStatement(n) ||
				ts.isForOfStatement(n) ||
				ts.isWhileStatement(n)
			) {
				executable += n.getText(sf) + '\n';
				addFrontmatter(n.getText(sf), n);
			} else throw new Error('Unsupported frontmatter statement: ' + ts.SyntaxKind[n.kind]);
		} catch (e) {
			error((e as Error).message, frontStart + n.getStart(sf), frontStart + n.end);
		}
	}
	let resolveContract: ReturnType<typeof contractResolver> | undefined;
	for (const name of ['Props', 'Server'] as const) {
		const n = aliases.get(name);
		if (n)
			try {
				let schemaType: Contract;
				try {
					schemaType = ts.isInterfaceDeclaration(n)
						? interfaceContract(n, aliases)
						: contract(n, aliases);
				} catch (e) {
					if (
						!/Unknown contract|Contract generics|Unsupported contract|Contract bases/.test(
							(e as Error).message,
						)
					)
						throw e;
					resolveContract ??= contractResolver(filename + '.ts', frontCode);
					try {
						schemaType = resolveContract(name);
					} catch (resolvedError) {
						throw new Error((e as Error).message + ' ' + (resolvedError as Error).message);
					}
				}
				result[name === 'Props' ? 'props' : 'server'] = schemaType;
				if (result[name === 'Props' ? 'props' : 'server'].kind !== 'object')
					throw new Error(`${name} must be an object contract.`);
				const schema = result[name === 'Props' ? 'props' : 'server'];
				if (name === 'Props' && hasFunction(schema))
					throw new Error('Functions are supported only as top-level Server methods.');
				if (schema.kind === 'object' && name === 'Server')
					for (const field of Object.values(schema.fields))
						if (field.type.kind === 'function' ? field.optional : hasFunction(field.type))
							throw new Error('Server methods must be required top-level fields.');
			} catch (e) {
				error((e as Error).message, frontStart + n.getStart(sf), frontStart + n.end);
			}
		else prefix += `interface ${name} {}\n`;
	}
	prefix += 'declare const props: Props; declare const server: Server;\n';
	if (options.contractsOnly) return result;
	const inputs: ExpressionInput[] = [];
	const refs = new Map<any, number>();
	function input(text: string, offset: number, key: any) {
		refs.set(key, inputs.length);
		inputs.push({ text, start: offset });
	}
	function exprText(n: any) {
		const s = source.indexOf('{', start(n)) + 1;
		const file = ts.createSourceFile(
			'expression.tsx',
			'const __ = (' + source.slice(s),
			99,
			true,
			ts.ScriptKind.TSX,
		);
		const init = (file.statements[0] as ts.VariableStatement)?.declarationList?.declarations[0]
			?.initializer;
		const expression = init && ts.isParenthesizedExpression(init) ? init.expression : init;
		return { text: source.slice(s, s + (expression?.end ?? 12) - 12), start: s };
	}
	function gather(n: any) {
		if (n.type === 'frontmatter') return;
		if (n.type === 'expression') {
			const x = exprText(n);
			input(x.text, x.start, n);
			return;
		}
		if (n.name === 'style' || n.name === 'script') return;
		for (const a of n.attributes ?? [])
			if (a.kind === 'expression' || a.kind === 'spread') {
				const s =
					a.kind === 'spread'
						? source.indexOf('...', start(a)) + 3
						: source.indexOf('{', start(a)) + 1;
				input(a.value, s, a);
			}
		if (n.type === 'component' && !result.imports[n.name]) {
			input(n.name, start(n) + 1, n);
		} else if (n.type === 'component') {
			const attrs = (n.attributes ?? [])
				.map((a: any) =>
					a.kind === 'spread'
						? `{...${a.value}}`
						: a.kind === 'expression'
							? `${a.name}={${a.value}}`
							: a.kind === 'empty'
								? a.name
								: `${a.name}=${JSON.stringify(a.value)}`,
				)
				.join(' ');
			input(`<${n.name} ${attrs} />`, start(n), {});
		}
		for (const c of n.children ?? []) gather(c);
	}
	gather(ast);
	const methods = new Set(
		result.server.kind === 'object'
			? Object.entries(result.server.fields)
					.filter(([, field]) => field.type.kind === 'function')
					.map(([name]) => name)
			: [],
	);
	const expressions = new Expressions(prefix, inputs, filename, prefixMappings, methods);
	const serializable = (v: unknown, seen = new Set<unknown>()): void => {
		if (
			v === null ||
			typeof v === 'string' ||
			typeof v === 'boolean' ||
			(typeof v === 'number' && Number.isFinite(v))
		)
			return;
		if (typeof v !== 'object' || seen.has(v))
			throw new Error('Template build-time bindings must be serializable constants.');
		seen.add(v);
		if (Array.isArray(v)) {
			for (const value of v) serializable(value, new Set(seen));
			return;
		}
		if (
			Object.prototype.toString.call(v) === '[object Object]' &&
			Object.getPrototypeOf(v)?.constructor?.name === 'Object'
		) {
			for (const value of Object.values(v!)) serializable(value, new Set(seen));
			return;
		}
		throw new Error('Template build-time bindings must be serializable constants.');
	};
	const calls: ts.CallExpression[] = [];
	function collectCalls(node: ts.Node) {
		if (ts.isCallExpression(node)) {
			let root: ts.Expression = node.expression;
			while (
				ts.isPropertyAccessExpression(root) ||
				ts.isElementAccessExpression(root) ||
				ts.isParenthesizedExpression(root)
			)
				root = root.expression;
			const binding = ts.isIdentifier(root)
				? expressions.checker.getSymbolAtLocation(root)?.declarations?.[0]
				: undefined;
			let staticCall =
				!!binding && binding.getSourceFile() === expressions.file && binding.end < prefix.length;
			function check(child: ts.Node) {
				if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child))
					staticCall = false;
				if (ts.isIdentifier(child)) {
					const symbol = ts.isShorthandPropertyAssignment(child.parent)
						? expressions.checker.getShorthandAssignmentValueSymbol(child.parent)
						: expressions.checker.getSymbolAtLocation(child);
					const declaration = symbol?.valueDeclaration;
					if (declaration?.getSourceFile() === expressions.file) {
						if (
							(child.text === 'props' || child.text === 'server') &&
							ts.isVariableDeclaration(declaration) &&
							!declaration.initializer
						)
							staticCall = false;
						if (
							declaration.end >= prefix.length &&
							(declaration.getStart() < node.getStart() || declaration.end > node.end)
						)
							staticCall = false;
					}
				}
				ts.forEachChild(child, check);
			}
			check(node);
			if (staticCall) {
				calls.push(node);
			}
		}
		ts.forEachChild(node, collectCalls);
	}
	for (const node of expressions.nodes) collectCalls(node);
	let constants: Record<string, unknown> = {};
	try {
		if (executable.trim() || calls.length) {
			const code = await bundle({
				stdin: {
					contents:
						executable +
						`\nglobalThis.__xphConstants={${constantNames.join(',')}};\nglobalThis.__xphCalls=[${calls.map((node) => `() => (${node.getText(expressions.file)})`).join(',')}];`,
					resolveDir: dirname(filename),
					loader: 'ts',
				},
				logLevel: 'silent',
				bundle: true,
				write: false,
				platform: 'node',
				format: 'cjs',
			});
			const sandbox: any = vm.createContext({
				__xphConstants: {},
				require: createRequire(filename),
				console,
				process,
				Buffer,
			});
			vm.runInContext(code.outputFiles![0].text, sandbox, { timeout: 2000 });
			constants = sandbox.__xphConstants;
			for (const [index, node] of calls.entries()) {
				let cached: string | undefined;
				expressions.buildTimeCalls.set(node, () => {
					if (cached !== undefined) return cached;
					try {
						const value = vm.runInContext(`__xphCalls[${index}]()`, sandbox, { timeout: 2000 });
						serializable(value);
						return (cached = phpLiteral(value));
					} catch (e) {
						return expressions.fail(node, `Build-time call: ${(e as Error).message}`);
					}
				});
			}
		}
	} catch (e) {
		constants = {};
		error(`Frontmatter: ${(e as Error).message}`, frontStart, frontStart + frontCode.length);
	}
	result.virtual = { code: expressions.code, mappings: expressions.mappings };
	diagnostics.push(...expressions.diagnostics);
	const range = (n: any) => ({ start: start(n), end: Math.max(start(n) + 1, end(n)) });
	function expressionIR(n: ts.Expression): IR[] {
		const r = expressions.range(n);
		if (ts.isParenthesizedExpression(n)) return expressionIR(n.expression);
		if (ts.isJsxFragment(n)) return n.children.flatMap(jsxChild);
		if (ts.isJsxElement(n)) return [jsxElement(n.openingElement, n.children)];
		if (ts.isJsxSelfClosingElement(n)) return [jsxElement(n, [])];
		if (ts.isConditionalExpression(n))
			return [
				{
					kind: 'branch',
					test: expressions.boolean(n.condition),
					yes: expressionIR(n.whenTrue),
					no: expressionIR(n.whenFalse),
					...r,
				},
			];
		if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
			return [
				{
					kind: 'branch',
					test: expressions.boolean(n.left),
					yes: expressionIR(n.right),
					no: [],
					...r,
				},
			];
		if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
			return [
				{
					kind: 'branch',
					test: expressions.boolean(n.left),
					yes: [],
					no: expressionIR(n.right),
					...r,
				},
			];
		if (
			ts.isCallExpression(n) &&
			ts.isPropertyAccessExpression(n.expression) &&
			n.expression.name.text === 'map' &&
			expressions.checker.isArrayType(
				expressions.checker.getTypeAtLocation(n.expression.expression),
			)
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
			const t = expressions.checker.getTypeAtLocation(n.expression.expression);
			if (!expressions.checker.isArrayType(t)) return expressions.fail(n, 'map requires an array.');
			return [
				{
					kind: 'loop',
					value: expressions.emit(n.expression.expression),
					item: expressions.parameterName(callback.parameters[0]),
					index: callback.parameters[1]
						? expressions.parameterName(callback.parameters[1])
						: undefined,
					children: expressionIR(callback.body),
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
		return [{ kind: 'expression', code: expressions.scalar(n), ...r }];
	}
	function jsxChild(n: ts.JsxChild): IR[] {
		if (ts.isJsxText(n)) return [{ kind: 'text', value: n.text, ...expressions.range(n) }];
		if (ts.isJsxExpression(n)) return n.expression ? expressionIR(n.expression) : [];
		return expressionIR(n as ts.Expression);
	}
	function spread(node: ts.Expression, component: boolean): string {
		const type = expressions.checker.getTypeAtLocation(node);
		const types = type.isUnion() ? type.types : [type];
		for (const t of types) {
			if (
				!(t.flags & ts.TypeFlags.Object) ||
				expressions.checker.isArrayType(t) ||
				expressions.checker.isTupleType(t) ||
				t.getCallSignatures().length
			)
				return expressions.fail(node, 'Spread attributes require an object.');
			if (!component)
				for (const property of t.getProperties()) {
					const name = property.getName();
					if (!/^[a-zA-Z_][\w.-]*$/.test(name) || /^on/i.test(name) || name === 'slot')
						return expressions.fail(node, 'Unsupported spread attribute ' + name);
					const value = expressions.checker.getTypeOfSymbolAtLocation(property, node);
					const values = value.isUnion() ? value.types : [value];
					if (
						values.some(
							(v) =>
								!(
									v.flags &
									(ts.TypeFlags.StringLike |
										ts.TypeFlags.NumberLike |
										ts.TypeFlags.BooleanLike |
										ts.TypeFlags.Null |
										ts.TypeFlags.Undefined)
								),
						)
					)
						return expressions.fail(
							node,
							'Only scalar values can be rendered as text or attributes.',
						);
				}
		}
		return expressions.emit(node);
	}
	function classCode(node: ts.Expression): string {
		if (ts.isParenthesizedExpression(node)) return classCode(node.expression);
		if (ts.isArrayLiteralExpression(node))
			return (
				'\\Xph\\classList([' +
				node.elements.map((item) => classCode(item as ts.Expression)).join(', ') +
				'])'
			);
		if (ts.isConditionalExpression(node))
			return (
				'(' +
				expressions.boolean(node.condition) +
				' ? ' +
				classCode(node.whenTrue) +
				' : ' +
				classCode(node.whenFalse) +
				')'
			);
		const type = expressions.checker.getTypeAtLocation(node);
		const types = type.isUnion() ? type.types : [type];
		const object =
			!types.some(
				(t) => expressions.checker.isArrayType(t) || expressions.checker.isTupleType(t),
			) &&
			types.some(
				(t) =>
					!!(t.flags & ts.TypeFlags.Object) &&
					!expressions.checker.isArrayType(t) &&
					!expressions.checker.isTupleType(t),
			);
		return '\\Xph\\classList(' + expressions.emit(node) + ', ' + (object ? 'true' : 'false') + ')';
	}
	function attributeProps(attributes: { name?: string; code: string }[]): string {
		return (
			(attributes.some((a) => a.name === 'class:list')
				? '\\Xph\\classProps('
				: '\\Xph\\mergeProps(') +
			attributes
				.map((a) =>
					a.name === undefined ? a.code : '[' + phpLiteral(a.name) + ' => ' + a.code + ']',
				)
				.join(', ') +
			')'
		);
	}
	function dynamicName(node: ts.Expression): string {
		if (!expressions.is(node, ts.TypeFlags.StringLike))
			return expressions.fail(node, 'Dynamic element names must have string type.');
		return expressions.emit(node);
	}
	function jsxElement(
		n: ts.JsxOpeningLikeElement,
		children: ts.NodeArray<ts.JsxChild> | ts.JsxChild[],
	): IR {
		const name = n.tagName.getText();
		if (['script', 'style'].includes(name))
			return expressions.fail(n, 'Assets inside template expressions are unsupported.');
		const attributes: { name?: string; code: string; start?: number; end?: number }[] = [];
		let html: string | undefined;
		let text: string | undefined;
		for (const a of n.attributes.properties) {
			if (ts.isJsxSpreadAttribute(a)) {
				attributes.push({
					code: spread(a.expression, !!result.imports[name]),
					...expressions.range(a.expression),
				});
				continue;
			}
			const key = a.name.getText();
			if (/^on/i.test(key))
				return expressions.fail(
					a,
					'Event-handler attributes are unsupported; use a browser script.',
				);
			let code = 'true';
			if (a.initializer) {
				if (ts.isStringLiteral(a.initializer)) code = phpLiteral(a.initializer.text);
				else if (ts.isJsxExpression(a.initializer) && a.initializer.expression)
					code =
						key === 'class:list'
							? classCode(a.initializer.expression)
							: result.imports[name]
								? expressions.emit(a.initializer.expression)
								: expressions.scalar(a.initializer.expression);
				else return expressions.fail(a, 'Unsupported JSX attribute.');
			}
			if (
				key === 'slot' ||
				(key.includes(':') && key !== 'set:html' && key !== 'set:text' && key !== 'class:list')
			)
				return expressions.fail(a, 'Unsupported attribute or directive ' + key);
			if (key === 'set:html' || key === 'set:text') {
				if (result.imports[name] || name === 'slot')
					return expressions.fail(a, key + ' requires an HTML element.');
				if (html !== undefined || text !== undefined)
					return expressions.fail(a, 'Content directives cannot be combined.');
				if (key === 'set:html') html = code;
				else text = code;
			} else
				attributes.push({
					name: key,
					code,
					...expressions.range(
						a.initializer && ts.isJsxExpression(a.initializer) && a.initializer.expression
							? a.initializer.expression
							: a,
					),
				});
		}
		if (name === 'slot' && attributes.length)
			return expressions.fail(n, 'Only default slots are supported.');
		if (name === 'slot')
			return { kind: 'slot', children: children.flatMap(jsxChild), ...expressions.range(n) };
		const tag =
			!result.imports[name] && (/^[A-Z]/.test(name) || name.includes('.'))
				? dynamicName(n.tagName as ts.Expression)
				: undefined;
		if ((html !== undefined || text !== undefined) && children.length)
			return expressions.fail(
				n,
				(text !== undefined ? 'set:text' : 'set:html') + ' cannot have children.',
			);
		if (!result.imports[name] && result.assets.some((a) => a.type === 'css'))
			attributes.push({ name: scope, code: "''" });
		return {
			kind: 'element',
			name,
			tag,
			attributes,
			children:
				text !== undefined
					? [{ kind: 'expression', code: text, ...expressions.range(n) }]
					: children.flatMap(jsxChild),
			html,
			component: result.imports[name] ? (options.components?.[name]?.id ?? name) : undefined,
			...expressions.range(n),
		};
	}
	// Extract assets first so JSX-created nodes receive the same scope as static nodes.
	async function assets(n: any): Promise<void> {
		if (n.name === 'script' || n.name === 'style') {
			const text = (n.children ?? []).map((c: any) => c.value ?? '').join('');
			if (n.name === 'script')
				diagnostics.push(
					...checkBrowser(text, filename + '.browser.ts', source.indexOf('>', start(n)) + 1),
				);
			for (const a of n.attributes ?? [])
				if (!['lang', 'is:global'].includes(a.name))
					error('Unsupported asset attribute ' + a.name, start(a));
			if (
				(n.attributes ?? []).some((a: any) => a.kind === 'expression') ||
				(n.children ?? []).some((c: any) => c.type !== 'text')
			) {
				error('Runtime interpolation in scripts and styles is unsupported.', start(n));
				return;
			}
			try {
				let content = text;
				const type = n.name === 'style' ? 'css' : 'js';
				if (type === 'css') {
					const css = postcss.parse(text);
					if (!(n.attributes ?? []).some((a: any) => a.name === 'is:global')) {
						const animations = new Map<string, string>();
						css.walkAtRules(/keyframes$/, (rule) => {
							const name = rule.params.trim();
							animations.set(name, name + '-' + id);
							rule.params = name + '-' + id;
						});
						css.walkDecls(/^(animation|animation-name)$/, (decl) => {
							decl.value = decl.value.replace(/[-\w]+/g, (word) => animations.get(word) ?? word);
						});
					}
					if (!(n.attributes ?? []).some((a: any) => a.name === 'is:global'))
						css.walkRules((rule) => {
							if (rule.parent?.type === 'atrule' && /keyframes$/i.test((rule.parent as any).name))
								return;
							rule.selector = selectorParser((selectors) => {
								selectors.each((sel) => {
									let compound: any[] = [];
									const finish = () => {
										if (!compound.length) return;
										const marker = selectorParser.attribute({
											attribute: scope,
											raws: {},
											value: undefined,
										});
										const pseudo = compound.find((node) => node.type === 'pseudo');
										if (pseudo) sel.insertBefore(pseudo, marker);
										else sel.insertAfter(compound.at(-1), marker);
										compound = [];
									};
									// Work on a snapshot because inserting nodes mutates the selector.
									// oxlint-disable-next-line unicorn/no-useless-spread -- finish() mutates sel.nodes.
									for (const node of [...sel.nodes]) {
										if (node.type === 'combinator') finish();
										else compound.push(node);
									}
									finish();
								});
							}).processSync(rule.selector);
						});
					content = css.toString();
				}
				const built = await bundle({
					stdin: {
						contents: content,
						resolveDir: dirname(filename),
						loader: type === 'css' ? 'css' : 'ts',
					},
					logLevel: 'silent',
					bundle: true,
					write: false,
					minify: true,
					format: 'esm',
					platform: 'browser',
				});
				content = built.outputFiles![0].text;
				result.assets.push({ type, content, filename: `${hash(content)}.${type}` });
			} catch (e) {
				error(`Asset: ${(e as Error).message}`, start(n));
			}
			return;
		}
		for (const c of n.children ?? []) await assets(c);
	}
	await assets(ast);
	function lower(n: any): IR[] {
		if (n.type === 'frontmatter' || n.name === 'style' || n.name === 'script') return [];
		if (n.type === 'root') {
			const nodes: IR[] = (n.children ?? []).flatMap(lower);
			while (nodes[0]?.kind === 'text' && !nodes[0].value.trim()) nodes.shift();
			return nodes;
		}
		if (n.type === 'fragment') return (n.children ?? []).flatMap(lower);
		if (n.type === 'text')
			return [
				{
					kind: 'text',
					value: extracted.blocks.reduce(
						(text, b) => text.replace(extracted.masked.slice(b.start, b.end), ''),
						n.value,
					),
					...range(n),
				},
			];
		if (
			n.type === 'comment' &&
			extracted.blocks.some((b) => start(n) >= b.start && start(n) < b.end)
		)
			return [];
		if (n.type === 'comment') return [{ kind: 'text', value: `<!--${n.value}-->`, ...range(n) }];
		if (n.type === 'doctype') return [{ kind: 'text', value: '<!DOCTYPE html>', ...range(n) }];
		if (n.type === 'expression') return expressionIR(expressions.nodes[refs.get(n)!]);
		if (!['element', 'component', 'custom-element'].includes(n.type)) {
			error('Unsupported template node ' + n.type, start(n));
			return [];
		}
		const attributes: { name?: string; code: string; start?: number; end?: number }[] = [];
		let html: string | undefined;
		let text: string | undefined;
		for (const a of n.attributes ?? []) {
			if (a.kind === 'spread') {
				attributes.push({
					code: spread(expressions.nodes[refs.get(a)!], !!result.imports[n.name]),
					...expressions.range(expressions.nodes[refs.get(a)!]),
				});
				continue;
			}
			if (!/^[a-zA-Z_:][\w:.-]*$/.test(a.name)) {
				error('Unsupported attribute.', start(a));
				continue;
			}
			if (/^on/i.test(a.name)) {
				error('Event-handler attributes are unsupported; use a browser script.', start(a));
				continue;
			}
			if (!['expression', 'quoted', 'empty'].includes(a.kind)) {
				error('Unsupported attribute syntax.', start(a));
				continue;
			}
			const code =
				a.kind === 'expression'
					? a.name === 'class:list'
						? classCode(expressions.nodes[refs.get(a)!])
						: result.imports[n.name]
							? expressions.emit(expressions.nodes[refs.get(a)!])
							: expressions.scalar(expressions.nodes[refs.get(a)!])
					: a.kind === 'empty'
						? 'true'
						: phpLiteral(decodeHTMLAttribute(a.value));
			if (a.name === 'set:html' || a.name === 'set:text') {
				if (result.imports[n.name] || n.name === 'slot')
					error(a.name + ' requires an HTML element.', start(a));
				if (html !== undefined || text !== undefined)
					error('Content directives cannot be combined.', start(a));
				if (a.name === 'set:html') html = code;
				else text = code;
			} else if (a.name === 'slot' || (a.name.includes(':') && a.name !== 'class:list'))
				error('Unsupported directive ' + a.name, start(a));
			else
				attributes.push({
					name: a.name,
					code,
					...(a.kind === 'expression'
						? expressions.range(expressions.nodes[refs.get(a)!])
						: range(a)),
				});
		}
		const children = (n.children ?? []).flatMap(lower);
		if (n.name === 'slot') {
			if (attributes.length) error('Only default slots are supported.', start(n));
			return [{ kind: 'slot', children, ...range(n) }];
		}
		const tag =
			n.type === 'component' && !result.imports[n.name]
				? dynamicName(expressions.nodes[refs.get(n)!])
				: undefined;
		if ((html !== undefined || text !== undefined) && children.length)
			error((text !== undefined ? 'set:text' : 'set:html') + ' cannot have children.', start(n));
		if (!result.imports[n.name] && result.assets.some((a) => a.type === 'css'))
			attributes.push({ name: scope, code: "''" });
		return [
			{
				kind: 'element',
				name: n.name,
				tag,
				attributes,
				children: text !== undefined ? [{ kind: 'expression', code: text, ...range(n) }] : children,
				html,
				component: result.imports[n.name]
					? (options.components?.[n.name]?.id ?? n.name)
					: undefined,
				...range(n),
			},
		];
	}
	try {
		result.ir = lower(ast);
	} catch (e) {
		if (!(e instanceof Error)) throw e;
		if (!expressions.diagnostics.some((d) => d.message === e.message)) error(e.message);
	}
	// Expression emission can add diagnostics after the initial TypeScript pass.
	for (const d of expressions.diagnostics) if (!diagnostics.includes(d)) diagnostics.push(d);
	const runtimeConstants: Record<string, unknown> = {};
	for (const name of expressions.constantNamesUsed) {
		try {
			if (!Object.hasOwn(constants, name)) throw new Error('Unsupported template binding: ' + name);
			serializable(constants[name]);
			runtimeConstants[name] = constants[name];
		} catch (e) {
			error((e as Error).message, frontStart, frontStart + frontCode.length);
		}
	}
	let php = '<?php\ndeclare(strict_types=1);\n';
	// Compact tuples are expanded into named fields only when reporting a failure.
	const locations: [number, number, number, number][] = [];
	const locationIds = new Map<string, number>();
	const location = (range: { start: number; end: number }): [number, number, number, number] => {
		const at = position(source, range.start);
		return [range.start, range.end, at.line + 1, at.character + 1];
	};
	const component = options.scopeId ? options.scopeId + '.xph' : basename(filename);
	const origins: Record<number, ReturnType<typeof location>> = {};
	let baseLine = 0;
	const catchCode = () =>
		`} catch (\\Throwable $__xph_error) {\nif (\\Xph\\runtimeDiagnosticsEnabled()) {\n` +
		`\\Xph\\recordRuntimeError($__xph_error, ${phpLiteral(component)}, (${phpLiteral(locations)})[$__xph_location] ?? [], ` +
		`$__xph_error->getFile() === __FILE__ ? ((${phpLiteral(origins)})[$__xph_error->getLine() - $__xph_base] ?? null) : null);\n}\nthrow $__xph_error;\n}\n`;

	const append = (text: string, n?: { start: number; end: number }, track = true) => {
		if (n && track) {
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
	append(
		`/** @param ${phpDoc(result.props)} $props */\nreturn static function (array $props, ?callable $slot = null): string {\n$constants = ${phpLiteral(runtimeConstants)};\n/** @var ${phpDoc(result.props)} $props */\n`,
	);
	baseLine = php.split('\n').length;
	append('$__xph_base = __LINE__;\n$__xph_location = -1;\ntry {\n');
	const block = extracted.blocks[0];
	if (block) {
		append(
			`/** @param ${phpDoc(result.props)} $props\n * @return ${phpDoc(result.server)} */\n$run = static function (array $props): array {\n`,
		);
		// Mark the call outside the isolated PHP scope; PHP-body line mappings use __LINE__.
		const blockLocation = locations.length;
		locations.push(
			location({ start: block.contentStart, end: block.contentStart + block.code.length }),
		);
		const generatedLine = php.split('\n').length - baseLine;
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
		append(`\n};\n$__xph_location = ${blockLocation};\n$server = $run($props);\n`);
	} else append('$server = [];\n');
	append(`/** @var ${phpDoc(result.server)} $server */\n`);
	append("$out = '';\n");
	let tagIndex = 0;
	function emit(nodes: IR[], activeVars: string[] = []) {
		for (const n of nodes) {
			switch (n.kind) {
				case 'text':
					append(`$out .= ${phpLiteral(n.value)};\n`, n, false);
					break;
				case 'expression':
					append(`$out .= \\Xph\\escape(${n.code});\n`, n);
					break;
				case 'branch':
					append(`if (${n.test}) {\n`, n);
					emit(n.yes, activeVars);
					append('} else {\n');
					emit(n.no, activeVars);
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
				case 'slot':
					append('if ($slot !== null) { $out .= $slot(); } else {\n', n);
					emit(n.children, activeVars);
					append('}\n');
					break;
				case 'element':
					if (n.component) {
						append(
							`$out .= \\Xph\\render(${phpLiteral(n.component)}, ${attributeProps(n.attributes)}, static function () use ($props, $server, $constants, $slot, $__xph_base${[...new Set(activeVars)].map((v) => ', $' + v).join('')}) {\n$__xph_location = -1;\ntry {\n$out = '';\n`,
							n,
						);
						emit(n.children, activeVars);
						append('return $out;\n' + catchCode() + '});\n');
					} else {
						const tag = n.tag ? '$__xph_tag_' + tagIndex++ : undefined;
						if (tag) append(`${tag} = \\Xph\\elementName(${n.tag});\n`, n);
						append(
							tag ? `$out .= '<' . ${tag};\n` : `$out .= ${phpLiteral('<' + n.name)};\n`,
							n,
							false,
						);
						if (n.attributes.some((a) => a.name === undefined || a.name === 'class:list'))
							append(
								`$out .= \\Xph\\attributes(${attributeProps(n.attributes)}, ${tag ?? phpLiteral(n.name)});\n`,
								n,
							);
						else
							for (const a of n.attributes)
								append(
									`$out .= \\Xph\\attribute(${phpLiteral(a.name!)}, ${a.code}, ${tag ?? phpLiteral(n.name)});\n`,
									a.start !== undefined && a.end !== undefined ? { start: a.start, end: a.end } : n,
								);
						append(`$out .= '>';\n`);
						if (n.html) append(`$out .= \\Xph\\raw(${n.html});\n`, n);
						else emit(n.children, activeVars);
						if (tag)
							append(
								`if (!in_array(strtolower(${tag}), ${phpLiteral([...voids])}, true)) { $out .= '</' . ${tag} . '>'; }\n`,
							);
						else if (!voids.has(n.name)) append(`$out .= ${phpLiteral('</' + n.name + '>')};\n`);
					}
					break;
			}
		}
	}
	emit(result.ir);
	append('return $out;\n' + catchCode() + '};\n');
	result.php = php;
	return result;
}
export function contractTS(c: Contract): string {
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
				Object.entries(c.fields)
					.map(([k, v]) => `${JSON.stringify(k)}${v.optional ? '?' : ''}: ${contractTS(v.type)}`)
					.join('; ') +
				'}'
			);
	}
}
