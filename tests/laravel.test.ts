import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { build } from '../packages/xph/src/build.js';

it('renders a compiler build through the Laravel adapter with dependency assets', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-laravel-build-'));
	try {
		await mkdir(join(root, 'resources'));
		await writeFile(
			join(root, 'resources', 'Child.xph'),
			'<span>Child</span><style>span { color: red }</style>',
		);
		await writeFile(
			join(root, 'resources', 'Page.xph'),
			`---
import Child from './Child.xph';
export interface Props { title: string }
---
<h1>{props.title}</h1><Child />
<script>console.log('ready');</script>`,
		);
		const result = await build({
			root,
			entries: ['resources/Page.xph'],
			outDir: 'build',
			assetBase: '/xph/',
		});
		expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		const runner = join(root, 'render.php');
		await writeFile(
			runner,
			`<?php
require $argv[1];
$renderer = new \\Xph\\Laravel\\Renderer($argv[2]);
$html = $renderer->render('resources/Page', ['title' => '<Hello>']);
echo $renderer->inject('<html><head></head><body>'.$html.$html.'</body></html>');
`,
		);
		const html = execFileSync('php', [
			runner,
			resolve('packages/laravel/src/Renderer.php'),
			result.outDir,
		]).toString();
		expect(html).toContain('&lt;Hello&gt;');
		expect(html).toContain('Child');
		for (const entry of Object.values(result.manifest)) {
			for (const asset of entry.assets) {
				expect(html.split(asset.url)).toHaveLength(2);
				expect(html.indexOf(asset.url)).toBeLessThan(
					html.indexOf(asset.type === 'css' ? '</head>' : '</body>'),
				);
			}
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
