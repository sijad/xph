import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createBuilder } from '../packages/xph/src/build.js';

it('shares dependency code and module identity across component scripts and rebuilds', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-shared-'));
	try {
		await mkdir(join(root, 'src'));
		await writeFile(join(root, 'package.json'), '{"type":"module"}');
		await writeFile(
			join(root, 'src/shared.js'),
			'globalThis.loads = (globalThis.loads || 0) + 1; export const value = "shared-library-marker";',
		);
		for (const name of ['A', 'B'])
			await writeFile(
				join(root, `src/${name}.xph`),
				`<script>import { value } from './shared.js'; console.log('${name}', value);</script>`,
			);
		const build = createBuilder({ root });
		for (const marker of ['shared-library-marker', 'updated-library-marker']) {
			await writeFile(
				join(root, 'src/shared.js'),
				`globalThis.loads = (globalThis.loads || 0) + 1; export const value = "${marker}";`,
			);
			const result = await build({ skipPhpCheck: true });
			expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
			const files = await readdir(join(root, 'dist/assets'));
			const contents = await Promise.all(
				files.map((file) => readFile(join(root, 'dist/assets', file), 'utf8')),
			);
			expect(contents.join('').split(marker)).toHaveLength(2);
			const entries = ['A', 'B'].map(
				(name) => result.manifest[name].assets.find((a) => a.type === 'js')!.url,
			);
			const code =
				entries.map((url) => `await import(${JSON.stringify('./dist' + url)});`).join('\n') +
				'\nconsole.log(globalThis.loads);';
			const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
				cwd: root,
				encoding: 'utf8',
			});
			expect(output).toContain(`A ${marker}`);
			expect(output).toContain(`B ${marker}`);
			expect(output.trim().split('\n').at(-1)).toBe('1');
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
