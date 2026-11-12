import { resolve } from 'node:path';
import { parseTemplate, templateChildren, type TemplateNode, type TemplateRoot } from './astro.js';
import { evaluateBuildTime, serializable } from './build-time.js';
import { emptyContract, phpLiteral } from './contracts.js';
import { hash, type CompileContext } from './context.js';
import { emitPHP, isInert } from './emit-php.js';
import { Expressions, ReportedError } from './expressions.js';
import { analyzeFrontmatter } from './frontmatter.js';
import {
	compressWhitespace,
	gatherExpressions,
	isDynamicTag,
	Lowering,
	validateSlots,
} from './lower.js';
import { extractPHP } from './source.js';
import { Assets } from './styles.js';
import type { CompileOptions, CompileResult, Diagnostic } from './types.js';

/**
 * Compile one component. The stages are:
 * 1. extract `<script is:server>` PHP and parse the masked template;
 * 2. analyze the frontmatter into a virtual TypeScript prefix and Props/Server contracts;
 * 3. type-check every template expression in one virtual file and run build-time code;
 * 4. extract and scope styles and scripts;
 * 5. lower the template to IR, then emit PHP.
 */
export async function compile(
	source: string,
	options: CompileOptions = {},
): Promise<CompileResult> {
	const filename = resolve(options.filename ?? 'component.xph');
	const id = hash(options.scopeId ?? filename);
	const extracted = extractPHP(source);
	const diagnostics: Diagnostic[] = [...extracted.diagnostics];
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
	const ctx: CompileContext = {
		source,
		filename,
		options,
		debug: options.debug === true,
		id,
		strategy: options.scopedStyleStrategy ?? 'attribute',
		scopeAttribute: `data-xph-${id}`,
		scopeClass: `xph-${id}`,
		result,
		diagnostics,
		error,
	};
	const hasErrors = () => diagnostics.some((d) => d.severity === 'error');
	if (!['attribute', 'class', 'where'].includes(ctx.strategy)) {
		error('scopedStyleStrategy must be attribute, class, or where.');
		return result;
	}

	let ast: TemplateRoot;
	try {
		const parsed = await parseTemplate(extracted.masked);
		ast = parsed.ast;
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
		if (!options.recover && hasErrors()) return result;
	} catch (e) {
		error(String(e));
		return result;
	}

	const fm = await analyzeFrontmatter(ctx, ast);
	if (options.contractsOnly) return result;

	const { inputs, refs } = gatherExpressions(source, ast, (name) => isDynamicTag(ctx, fm, name));
	const methods = new Set(
		result.server.kind === 'object'
			? Object.entries(result.server.fields)
					.filter(([, field]) => field.type.kind === 'function')
					.map(([name]) => name)
			: [],
	);
	const expressions = new Expressions(fm.prefix, inputs, filename, fm.prefixMappings, methods);
	const constants = await evaluateBuildTime(ctx, fm, expressions);
	expressions.constants = constants;
	expressions.constantLiteral = (name) => {
		serializable(constants[name]);
		return phpLiteral(constants[name]);
	};
	result.virtual = { code: expressions.code, mappings: expressions.mappings };
	diagnostics.push(...expressions.diagnostics);

	const assets = new Assets(ctx);
	await assets.extract(ast, fm);
	const lowering = new Lowering(ctx, fm, expressions, assets, refs, extracted);
	try {
		// The first pass resolves build-time calls in lowering order and reports diagnostics.
		// Only an error-free template is lowered again with constant folding; build-time calls
		// are cached, so a helper that mutates frontmatter state never runs twice.
		result.ir = lowering.lower(ast);
		if (!hasErrors() && !expressions.diagnostics.length) {
			expressions.foldConstants = true;
			result.ir = lowering.lower(ast);
		}
		if (options.compressHTML !== false) {
			const opaque = opaqueText(ast, assets);
			compressWhitespace(result.ir, opaque);
			for (const helper of lowering.markupHelpers) compressWhitespace(helper.nodes, opaque);
		}
		validateSlots(result.ir, error);
		for (const helper of lowering.markupHelpers) validateSlots(helper.nodes, error);
	} catch (e) {
		if (!(e instanceof Error)) throw e;
		if (!(e instanceof ReportedError)) error(e.message);
	}
	// Expression emission can add diagnostics after the initial TypeScript pass.
	for (const d of expressions.diagnostics) if (!diagnostics.includes(d)) diagnostics.push(d);
	for (const name of expressions.constantNamesUsed) {
		try {
			if (!Object.hasOwn(constants, name)) throw new Error('Unsupported template binding: ' + name);
			serializable(constants[name]);
		} catch (e) {
			error((e as Error).message, fm.start, fm.start + fm.code.length);
		}
	}

	result.renderless = !extracted.blocks.length && isInert(result.ir, options);
	if (result.renderless) result.php = "<?php\nreturn static fn (): string => '';\n";
	else
		result.php = emitPHP(ctx, result.ir, lowering.markupHelpers, expressions, extracted.blocks[0]);
	return result;
}

/** Start offsets of inline assets, comments and doctypes: opaque text IR, not HTML text content. */
function opaqueText(ast: TemplateNode, assets: Assets) {
	const opaque = new Set<number>();
	const visit = (n: TemplateNode) => {
		if (assets.inline.has(n) || n.type === 'comment' || n.type === 'doctype') opaque.add(n.start);
		for (const child of templateChildren(n)) visit(child);
	};
	visit(ast);
	return opaque;
}
