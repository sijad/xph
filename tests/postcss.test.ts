import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../packages/xph/src/compiler.js';
import { createBuilder } from '../packages/xph/src/build.js';

it.each(['cjs', 'mjs'])(
	'loads project postcss.config.%s before scoping and skips inline styles',
	async (extension) => {
		const root = await mkdtemp(join(tmpdir(), 'xph-postcss-'));
		try {
			await mkdir(join(root, 'src/nested'), { recursive: true });
			await writeFile(
				join(root, `postcss.config.${extension}`),
				`${extension === 'cjs' ? 'module.exports =' : 'export default'} {
          plugins: [{
            postcssPlugin: 'test-colors',
            async Once(root) {
              await Promise.resolve();
              root.walkDecls((decl) => { if (decl.value === 'brand') decl.value = 'purple'; });
              root.append({ selector: '.generated', nodes: [{ prop: 'color', value: 'purple' }] });
            }
          }]
        };`,
			);
			const source =
				'<p>Hello</p><style>p { color: brand }</style><style is:global>body { color: brand }</style><style is:inline>p { color: brand }</style>';
			const result = await compile(source, { filename: join(root, 'src/nested/Page.xph') });
			expect(result.diagnostics).toEqual([]);
			expect(result.assets).toHaveLength(2);
			expect(result.assets[0].content).toMatch(/\.generated\[data-xph-/);
			expect(result.assets[0].content).toContain('purple');
			expect(result.assets[1].content).toContain('body,.generated{color:purple}');
			expect(result.assets[1].content).not.toContain('data-xph-');
			expect(result.php).toContain('p { color: brand }');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

it('reports configuration failures as asset diagnostics', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-postcss-error-'));
	try {
		await writeFile(join(root, 'postcss.config.cjs'), 'throw new Error("broken PostCSS config")');
		const result = await compile('<style>p { color: red }</style>', {
			filename: join(root, 'Page.xph'),
		});
		expect(
			result.diagnostics.some(
				(d) => d.severity === 'error' && d.message.includes('broken PostCSS config'),
			),
		).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('runs PostCSS again for unchanged components on rebuild', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-postcss-rebuild-'));
	try {
		await mkdir(join(root, 'src'));
		await writeFile(join(root, 'src/Page.xph'), '<style>p { color: brand }</style>');
		await writeFile(
			join(root, 'postcss.config.cjs'),
			`const fs = require('node:fs'); module.exports = { plugins: [{ postcssPlugin: 'external-color', Declaration(decl) { decl.value = fs.readFileSync(__dirname + '/color.txt', 'utf8'); } }] };`,
		);
		const build = createBuilder({ root });
		for (const color of ['red', 'purple']) {
			await writeFile(join(root, 'color.txt'), color);
			const result = await build({ write: false, skipPhpCheck: true });
			expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
			expect(result.components.get(join(root, 'src/Page.xph'))!.assets[0].content).toContain(color);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('resolves named plugins from the project and reports plugin warnings', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-postcss-plugins-'));
	try {
		await mkdir(join(root, 'node_modules/test-postcss-plugin'), { recursive: true });
		await writeFile(
			join(root, 'node_modules/test-postcss-plugin/package.json'),
			'{"name":"test-postcss-plugin","main":"index.cjs"}',
		);
		await writeFile(
			join(root, 'node_modules/test-postcss-plugin/index.cjs'),
			`module.exports = (options) => ({ postcssPlugin: 'test-postcss-plugin', Once(root, { result }) { root.walkDecls((decl) => { decl.value = options.color; }); result.warn('plugin warning'); } }); module.exports.postcss = true;`,
		);
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ postcss: { plugins: { 'test-postcss-plugin': { color: 'purple' } } } }),
		);
		const result = await compile('<style>p { color: brand }</style>', {
			filename: join(root, 'Page.xph'),
		});
		expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		expect(
			result.diagnostics.some(
				(d) => d.severity === 'warning' && d.message.includes('plugin warning'),
			),
		).toBe(true);
		expect(result.assets[0].content).toContain('purple');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
