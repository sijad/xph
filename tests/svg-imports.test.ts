import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { compile } from '../packages/xph/src/compiler.js';
import { createBuilder } from '../packages/xph/src/build.js';
import { definition, templateDefinition } from '../packages/xph-wordpress/src/metadata.js';

it('renders imported SVG components with attributes, expressions, and refreshed file contents', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-svg-'));
	try {
		await mkdir(join(root, 'src'));
		const filename = join(root, 'src/Page.xph');
		const source = `---\nimport Logo from './logo.svg';\ninterface Props { size: number }\nexport const template = { name: 'SVG Page' };\n---\n<Logo width={props.size} class="logo" aria-label="Logo" />{[24].map((size) => <Logo width={size} />)}<style>.logo { color: red }</style>`;
		await writeFile(filename, source);
		const build = createBuilder({ root });
		for (const fill of ['red', 'green']) {
			await writeFile(
				join(root, 'src/logo.svg'),
				`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="100" viewBox="0 0 24 24"><path fill="${fill}" d="M0 0h24v24z" /></svg>`,
			);
			const result = await build({ skipPhpCheck: true });
			expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
			expect(await definition(filename)).toBeUndefined();
			expect(await templateDefinition(filename)).toEqual({ name: 'SVG Page' });
			const php = result.components.get(filename)!.php;
			await writeFile(join(root, 'page.php'), php);
			const output = execFileSync(
				'php',
				[
					'-r',
					`require $argv[1]; $render = require $argv[2]; echo $render(['size' => 48], [], null);`,
					resolve('packages/xph/runtime/runtime.php'),
					join(root, 'page.php'),
				],
				{ encoding: 'utf8' },
			);
			expect(output).toContain('width="48"');
			expect(output).toContain('width="24"');
			expect(output).not.toContain('width="100"');
			expect(output).toContain(`fill="${fill}"`);
			expect(output).toContain('viewBox="0 0 24 24"');
			expect(output).toContain('aria-label="Logo"');
			expect(output).toContain('data-xph-');
			expect(output).not.toContain('<?xml');
		}
		const missing = await compile(`---\nimport Logo from './missing.svg';\n---\n<Logo />`, {
			filename,
		});
		expect(
			missing.diagnostics.some((d) => d.severity === 'error' && d.message.includes('missing.svg')),
		).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
