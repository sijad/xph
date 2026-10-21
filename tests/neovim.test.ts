import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'vitest';

const hasNeovim = (() => {
	try {
		execFileSync('nvim', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();
it.skipIf(!hasNeovim)('supports Neovim highlighting and the real CLI language server', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-neovim-'));
	try {
		await writeFile(
			join(root, 'xph.config.ts'),
			'export default { entries: [], php: "/missing/xph-test-php" };',
		);
		await writeFile(
			join(root, 'Page.xph'),
			[
				'---',
				'export interface Props { title: string }',
				'---',
				'<script is:server>',
				'$title = "Hello";',
				'$closing = "</script>";',
				'return [];',
				'</script>',
				'<h1>{props.title}</h1>',
				'<script>',
				'const count: number = 1;',
				'</script>',
				'<style>',
				'h1 { color: red }',
				'</style>',
				'<meta charset="utf-8" />',
			].join('\n'),
		);
		execFileSync(
			'nvim',
			['--headless', '-u', 'NONE', '-i', 'NONE', '-n', '-l', resolve('tests/neovim/smoke.lua')],
			{
				encoding: 'utf8',
				timeout: 14000,
				env: {
					...process.env,
					XPH_NVIM_RUNTIME: resolve('packages/neovim'),
					XPH_NVIM_PROJECT: root,
					XPH_NVIM_CLI: resolve('packages/xph/dist/cli.js'),
					XPH_NVIM_NODE: process.execPath,
					NVIM_LOG_FILE: join(root, 'nvim.log'),
					XDG_STATE_HOME: root,
				},
				stdio: 'pipe',
			},
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

const treesitterRuntime =
	process.env.XPH_NVIM_TS_RUNTIME ??
	join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'nvim/site');
const hasTreesitter = ['astro', 'php_only', 'typescript', 'css'].every(
	(language) =>
		existsSync(join(treesitterRuntime, 'parser', `${language}.so`)) &&
		existsSync(join(treesitterRuntime, 'queries', language, 'highlights.scm')),
);
it.skipIf(!hasNeovim || !hasTreesitter)(
	'reuses Astro Tree-sitter highlighting with exclusive PHP injections',
	async () => {
		const root = await mkdtemp(join(tmpdir(), 'xph-neovim-treesitter-'));
		try {
			execFileSync(
				'nvim',
				[
					'--headless',
					'-u',
					'NONE',
					'-i',
					'NONE',
					'-n',
					'-l',
					resolve('tests/neovim/treesitter.lua'),
				],
				{
					encoding: 'utf8',
					timeout: 10000,
					stdio: 'pipe',
					env: {
						...process.env,
						XPH_NVIM_RUNTIME: resolve('packages/neovim'),
						XPH_NVIM_TS_RUNTIME: treesitterRuntime,
						XDG_STATE_HOME: root,
						NVIM_LOG_FILE: join(root, 'nvim.log'),
					},
				},
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
