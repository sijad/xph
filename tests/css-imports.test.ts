import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../packages/xph/src/compiler.js';
import { createBuilder } from '../packages/xph/src/build.js';

it('bundles global frontmatter CSS imports and refreshes nested styles on rebuild', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-css-import-'));
	try {
		await mkdir(join(root, 'src'));
		await writeFile(
			join(root, 'src/Page.xph'),
			`---\nimport './styles.css';\nconst title = 'Hello';\n---\n<h1>{title}</h1>`,
		);
		await writeFile(
			join(root, 'src/styles.css'),
			'@import "./nested.css"; body { margin: 0 } @font-face { font-family: Omnes; src: url("./fonts/omnes-regular.woff2") format("woff2"); }',
		);
		const build = createBuilder({ root });
		for (const color of ['purple', 'green']) {
			await writeFile(join(root, 'src/nested.css'), `h1 { color: ${color} }`);
			const result = await build({ skipPhpCheck: true });
			expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
			const component = result.components.get(join(root, 'src/Page.xph'))!;
			expect(component.imports).toEqual({});
			expect(component.php).toContain('Hello');
			expect(component.assets).toHaveLength(1);
			expect(component.assets[0].content).toContain(`h1{color:${color}}`);
			expect(component.assets[0].content).toContain('body{margin:0}');
			expect(component.assets[0].content).toContain('./fonts/omnes-regular.woff2');
			expect(component.assets[0].content).not.toContain('data-xph-');
			expect(result.manifest.Page.assets[0].type).toBe('css');
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('preserves runtime asset URLs in style blocks', async () => {
	const result = await compile('<style>p { background: url("./images/background.png") }</style>');
	expect(result.diagnostics).toEqual([]);
	expect(result.assets[0].content).toContain('./images/background.png');
});

it('reports missing stylesheets and rejects CSS bindings', async () => {
	for (const statement of [`import './missing.css';`, `import styles from './styles.css';`]) {
		const result = await compile(`---\n${statement}\n---\n<p>Hello</p>`);
		expect(
			result.diagnostics.some(
				(d) => d.severity === 'error' && /CSS imports|Could not resolve/.test(d.message),
			),
		).toBe(true);
	}
});
