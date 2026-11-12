import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { build as bundle } from 'esbuild';
import { phpLiteral } from './contracts.js';
import type { CompileContext } from './context.js';
import type { Expressions } from './expressions.js';
import type { Frontmatter } from './frontmatter.js';

const TIMEOUT = 2000;

/** Throw unless a value can be emitted as a PHP literal: plain data without cycles. */
export function serializable(v: unknown, seen = new Set<unknown>()): void {
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
		(Object.getPrototypeOf(v) === null || Object.getPrototypeOf(v)?.constructor?.name === 'Object')
	) {
		for (const value of Object.values(v!)) serializable(value, new Set(seen));
		return;
	}
	throw new Error('Template build-time bindings must be serializable constants.');
}

/**
 * Template calls that only reach frontmatter bindings, such as `{format(title)}` with a
 * frontmatter `format` and `title`, run at build time and are emitted as literals.
 * A call is dynamic when it reads props, server or xph, contains markup, is an array map
 * (lowered to a loop), or reads a binding declared outside the call itself in the template.
 */
function buildTimeCalls(expressions: Expressions, prefixLength: number): ts.CallExpression[] {
	const { checker, file } = expressions;
	const calls: ts.CallExpression[] = [];
	const isArrayMap = (node: ts.CallExpression) =>
		ts.isPropertyAccessExpression(node.expression) &&
		node.expression.name.text === 'map' &&
		checker.isArrayType(checker.getTypeAtLocation(node.expression.expression));
	function isStatic(node: ts.CallExpression) {
		let root: ts.Expression = node.expression;
		while (
			ts.isPropertyAccessExpression(root) ||
			ts.isElementAccessExpression(root) ||
			ts.isParenthesizedExpression(root)
		)
			root = root.expression;
		if (!ts.isIdentifier(root) || root.text === 'xph' || isArrayMap(node)) return false;
		const binding = checker.getSymbolAtLocation(root)?.declarations?.[0];
		// The callee must be declared by the frontmatter part of the virtual file.
		if (!binding || binding.getSourceFile() !== file || binding.end >= prefixLength) return false;
		let result = true;
		function check(child: ts.Node) {
			if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child))
				result = false;
			if (ts.isIdentifier(child)) {
				const symbol = ts.isShorthandPropertyAssignment(child.parent)
					? checker.getShorthandAssignmentValueSymbol(child.parent)
					: checker.getSymbolAtLocation(child);
				const declaration = symbol?.valueDeclaration;
				if (declaration?.getSourceFile() === file) {
					// props, server and xph are declared without initializers: request-time values.
					if (
						(child.text === 'props' || child.text === 'server' || child.text === 'xph') &&
						ts.isVariableDeclaration(declaration) &&
						!declaration.initializer
					)
						result = false;
					// Template bindings (map parameters) are fine only when the call declares them.
					if (
						declaration.end >= prefixLength &&
						(declaration.getStart() < node.getStart() || declaration.end > node.end)
					)
						result = false;
				}
			}
			ts.forEachChild(child, check);
		}
		check(node);
		return result;
	}
	function collect(node: ts.Node) {
		if (ts.isCallExpression(node) && isStatic(node)) calls.push(node);
		ts.forEachChild(node, collect);
	}
	for (const node of expressions.nodes) collect(node);
	return calls;
}

/**
 * Run the frontmatter and register lazy build-time calls on `expressions`.
 * The VM context is not a security boundary: frontmatter is trusted project code with
 * real `require` and `process`, exactly as in the build tool that loads it.
 */
export async function evaluateBuildTime(
	ctx: CompileContext,
	fm: Frontmatter,
	expressions: Expressions,
): Promise<Record<string, unknown>> {
	const calls = buildTimeCalls(expressions, fm.prefix.length);
	if (!fm.executable.trim() && !calls.length) return {};
	try {
		const code = await bundle({
			stdin: {
				contents:
					fm.executable +
					`\nglobalThis.__xphConstants={${fm.constantNames.join(',')}};\nglobalThis.__xphCalls=[${calls.map((node) => `() => (${node.getText(expressions.file)})`).join(',')}];`,
				resolveDir: dirname(ctx.filename),
				loader: 'ts',
			},
			logLevel: 'silent',
			bundle: true,
			write: false,
			platform: 'node',
			format: 'cjs',
		});
		const context: any = vm.createContext({
			__xphConstants: {},
			require: createRequire(ctx.filename),
			console,
			process,
			Buffer,
			TextEncoder,
			TextDecoder,
		});
		vm.runInContext(code.outputFiles[0].text, context, { timeout: TIMEOUT });
		for (const [index, node] of calls.entries()) {
			let cached: string | undefined;
			// Calls run on first emission, in lowering order, and never twice: a helper may
			// mutate an object exported by the frontmatter.
			expressions.buildTimeCalls.set(node, () => {
				if (cached !== undefined) return cached;
				try {
					const value = vm.runInContext(`__xphCalls[${index}]()`, context, { timeout: TIMEOUT });
					serializable(value);
					expressions.buildTimeValues.set(node, { value: structuredClone(value) });
					return (cached = phpLiteral(value));
				} catch (e) {
					return expressions.fail(node, `Build-time call: ${(e as Error).message}`);
				}
			});
		}
		return context.__xphConstants;
	} catch (e) {
		ctx.error(`Frontmatter: ${(e as Error).message}`, fm.start, fm.start + fm.code.length);
		return {};
	}
}
