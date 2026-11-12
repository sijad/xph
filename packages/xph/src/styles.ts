import { dirname } from 'node:path';
import { build as bundle, type Plugin } from 'esbuild';
import postcss, { type Root } from 'postcss';
import loadPostcssConfig from 'postcss-load-config';
import selectorParser from 'postcss-selector-parser';
import { checkBrowser } from './typescript.js';
import { hash, type CompileContext } from './context.js';
import { isTemplateElement, templateChildren, type TemplateNode } from './astro.js';
import type { Frontmatter } from './frontmatter.js';

const preserveCSSUrls: Plugin = {
	name: 'xph-preserve-css-urls',
	setup(plugin) {
		plugin.onResolve({ filter: /.*/ }, (args) =>
			args.kind === 'url-token' ? { path: args.path, external: true } : undefined,
		);
	},
};

/** Collects a component's `<style>`/`<script>` assets; inline ones stay in the template as text. */
export class Assets {
	/** `is:inline` elements and their source text, emitted verbatim by lowering. */
	readonly inline = new Map<TemplateNode, string>();
	private postcssConfig?: ReturnType<typeof loadPostcssConfig>;
	constructor(private ctx: CompileContext) {}

	get hasCSS() {
		return this.ctx.result.assets.some((a) => a.type === 'css');
	}

	/** Extract assets before lowering so JSX-created nodes receive the same scope as static nodes. */
	async extract(ast: TemplateNode, fm: Frontmatter) {
		if (fm.cssImports.length) await this.cssImports(fm);
		await this.visit(ast);
	}

	private async process(text: string, offset: number): Promise<Root> {
		const { filename, diagnostics } = this.ctx;
		this.postcssConfig ??= loadPostcssConfig(
			{ cwd: dirname(filename), env: process.env.NODE_ENV ?? 'production' },
			dirname(filename),
		);
		let config;
		try {
			config = await this.postcssConfig;
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('No PostCSS Config found in:'))
				return postcss.parse(text, { from: filename });
			throw error;
		}
		const processed = await postcss(config.plugins).process(text, {
			...config.options,
			from: filename,
			map: false,
		});
		for (const warning of processed.warnings())
			diagnostics.push({
				source: 'xph',
				severity: 'warning',
				start: offset,
				end: offset,
				message: `PostCSS: ${warning.toString()}`,
			});
		// Component styles are single stylesheets; postcss only produces a Document for custom syntaxes.
		return processed.root as Root;
	}

	private async cssImports(fm: Frontmatter) {
		const { ctx } = this;
		try {
			const built = await bundle({
				plugins: [preserveCSSUrls],
				stdin: {
					contents: fm.cssImports.map((path) => `@import ${JSON.stringify(path)};`).join('\n'),
					resolveDir: dirname(ctx.filename),
					loader: 'css',
				},
				bundle: true,
				write: false,
				minify: true,
				logLevel: 'silent',
			});
			const content = (await this.process(built.outputFiles[0].text, fm.start)).toString();
			ctx.result.assets.push({ type: 'css', content, filename: `${hash(content)}.css` });
		} catch (e) {
			ctx.error(`Asset: ${(e as Error).message}`, fm.start, fm.start + fm.code.length);
		}
	}

	private async visit(n: TemplateNode): Promise<void> {
		if (!isTemplateElement(n) || (n.name !== 'script' && n.name !== 'style')) {
			for (const c of templateChildren(n)) await this.visit(c);
			return;
		}
		const { ctx } = this;
		const { source, filename, error } = ctx;
		if (n.attributes.some((a) => a.name === 'is:inline')) {
			for (const a of n.attributes) {
				if (a.kind !== 'empty' && a.kind !== 'quoted')
					error('Runtime interpolation in scripts and styles is unsupported.', a.start);
				if (a.name === 'is:inline' && a.kind !== 'empty')
					error('is:inline must be a boolean directive.', a.start);
			}
			let value = source.slice(n.start, n.end);
			for (const a of [...n.attributes].reverse())
				if (a.name === 'is:inline') {
					const offset = a.start - n.start;
					value = value.slice(0, offset).trimEnd() + value.slice(a.end - n.start);
				}
			this.inline.set(n, value);
			return;
		}
		const text = n.children.map((c) => ('value' in c ? c.value : '')).join('');
		if (n.name === 'script')
			ctx.diagnostics.push(
				...checkBrowser(text, filename + '.browser.ts', source.indexOf('>', n.start) + 1),
			);
		for (const a of n.attributes)
			if (a.name !== 'lang' && a.name !== 'is:global')
				error('Unsupported asset attribute ' + a.name, a.start);
		if (
			n.attributes.some((a) => a.kind === 'expression') ||
			n.children.some((c) => c.type !== 'text')
		) {
			error('Runtime interpolation in scripts and styles is unsupported.', n.start);
			return;
		}
		try {
			let content = text;
			const type = n.name === 'style' ? 'css' : 'js';
			if (type === 'css') {
				const css = await this.process(text, n.start);
				if (!n.attributes.some((a) => a.name === 'is:global')) scopeStyles(css, ctx);
				content = css.toString();
			}
			if (type === 'js' && ctx.options.deferScripts) {
				ctx.result.assets.push({ type, content, filename: `${hash(content)}.js` });
				return;
			}
			const built = await bundle({
				plugins: [preserveCSSUrls],
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
			content = built.outputFiles[0].text;
			ctx.result.assets.push({ type, content, filename: `${hash(content)}.${type}` });
		} catch (e) {
			error(`Asset: ${(e as Error).message}`, n.start);
		}
	}
}

/** Suffix keyframes with the component id and add the scope marker to every compound selector. */
function scopeStyles(css: Root, ctx: CompileContext) {
	const { id, strategy, scopeAttribute, scopeClass } = ctx;
	const animations = new Map<string, string>();
	css.walkAtRules(/keyframes$/, (rule) => {
		const name = rule.params.trim();
		animations.set(name, name + '-' + id);
		rule.params = name + '-' + id;
	});
	css.walkDecls(/^(animation|animation-name)$/, (decl) => {
		decl.value = decl.value.replace(/[-\w]+/g, (word) => animations.get(word) ?? word);
	});
	const markerSelector =
		strategy === 'attribute'
			? `[${scopeAttribute}]`
			: strategy === 'class'
				? `.${scopeClass}`
				: `:where(.${scopeClass})`;
	css.walkRules((rule) => {
		if (rule.parent?.type === 'atrule' && /keyframes$/i.test((rule.parent as any).name)) return;
		rule.selector = selectorParser((selectors) => {
			// `.a .b:hover` becomes `.a[m] .b[m]:hover`: the marker goes before the first
			// pseudo of each compound, and compounds that are only `:global(...)` are left alone.
			selectors.each((sel) => {
				let compound: any[] = [];
				const finish = () => {
					if (compound.some((node) => node.type !== 'pseudo' || node.value !== ':global')) {
						const marker = selectorParser().astSync(markerSelector).first.first.clone();
						const pseudo = compound.find((node) => node.type === 'pseudo');
						if (pseudo) sel.insertBefore(pseudo, marker);
						else sel.insertAfter(compound.at(-1), marker);
					}
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
			// Unwrap after scoping so global contents never receive a marker. A selector with
			// `:global(.x, .y)` expands into one selector per alternative, which preserves
			// specificity (unlike :is()). Repeat until no :global remains, innermost included.
			while (true) {
				let global: any;
				selectors.walkPseudos((node) => {
					if (!global && node.value === ':global') global = node;
				});
				if (!global) break;
				if (!global.nodes?.length || global.nodes.some((node: any) => !node.nodes?.length))
					throw new Error(':global() requires a selector.');
				const parent = global.parent;
				const index = parent.nodes.indexOf(global);
				for (const alternative of global.nodes) {
					const expanded = parent.clone();
					expanded.nodes[index].replaceWith(...alternative.nodes.map((node: any) => node.clone()));
					parent.parent.insertBefore(parent, expanded);
				}
				parent.remove();
			}
		}).processSync(rule.selector);
	});
}
