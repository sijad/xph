import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decodeHTML } from 'entities';
import { expect, it } from 'vitest';
import { buildWebsite } from '../scripts/build-website.mjs';
import { previewWebsite } from '../scripts/preview-website.mjs';
import { renderReference } from '../scripts/reference.mjs';

const examples = (html: string) =>
	[...html.matchAll(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((match) =>
		decodeHTML(match[1].replace(/<[^>]+>/g, '')),
	);

it('rebuilds the preview after index.html is saved or replaced', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'xph-website-preview-'));
	const sourceDir = join(directory, 'source');
	const outDir = join(directory, 'output');
	const referenceFile = join(directory, 'reference.md');
	let server;
	try {
		await cp(resolve('website'), sourceDir, {
			recursive: true,
			filter: (path) => path !== resolve('website/dist'),
		});
		await cp(resolve('docs/reference.md'), referenceFile);
		server = await previewWebsite({ port: 0, sourceDir, outDir, referenceFile });
		for (const replace of [false, true]) {
			const marker = `<p>Updated preview ${replace}</p>`;
			const source = await readFile(join(sourceDir, 'index.html'), 'utf8');
			const target = join(sourceDir, replace ? 'index.tmp' : 'index.html');
			await writeFile(target, source.replace('</body>', `${marker}</body>`));
			if (replace) await rename(target, join(sourceDir, 'index.html'));
			await expect.poll(() => readFile(join(outDir, 'index.html'), 'utf8')).toContain(marker);
		}
		const reference = await readFile(referenceFile, 'utf8');
		await writeFile(
			referenceFile,
			reference.replace('### Build-time code', '### Updated reference'),
		);
		await expect
			.poll(() => readFile(join(outDir, 'index.html'), 'utf8'))
			.toContain('<h4>Updated reference</h4>');
	} finally {
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});

it('builds the website with highlighted examples while preserving their exact text and assets', async () => {
	const outDir = await mkdtemp(join(tmpdir(), 'xph-website-'));
	const source = await readFile(resolve('website/index.html'), 'utf8');
	const reference = renderReference(await readFile(resolve('docs/reference.md'), 'utf8'));
	const expanded = source.replace(/^\t*<!-- xph:reference -->/m, () => reference);
	try {
		const { count } = await buildWebsite({ outDir });
		const html = await readFile(join(outDir, 'index.html'), 'utf8');
		expect(count).toBe(examples(expanded).length);
		expect(count).toBeGreaterThan(0);
		expect(examples(html)).toEqual(examples(expanded));
		expect(html).not.toContain('<!-- xph:reference -->');
		expect([...html.matchAll(/class="syntax-group"/g)]).toHaveLength(6);
		expect(html).toContain('href="#component-data"');
		expect(html).toContain('<h3 id="component-data">');
		expect(html).toContain('id="build-time-code"');
		expect(html).toContain('id="expressions--control-flow"');
		expect(await readFile(resolve('website/index.html'), 'utf8')).toBe(source);
		const blocks = [...html.matchAll(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/g)];
		expect(blocks.every((block) => block[1].includes('<span style="color:'))).toBe(true);
		for (const file of ['style.css', 'site.js', 'favicon.svg'])
			expect(await readFile(join(outDir, file))).toEqual(await readFile(resolve('website', file)));
		await buildWebsite({ outDir });
		expect(await readFile(join(outDir, 'index.html'), 'utf8')).toBe(html);
	} finally {
		await rm(outDir, { recursive: true, force: true });
	}
});

it('leaves the previous build intact when an example language is missing or unsupported', async () => {
	const sourceDir = await mkdtemp(join(tmpdir(), 'xph-website-invalid-'));
	const outDir = await mkdtemp(join(tmpdir(), 'xph-website-output-'));
	try {
		await writeFile(join(outDir, 'index.html'), 'previous build');
		for (const attributes of ['', ' data-language="not-a-language"']) {
			await writeFile(join(sourceDir, 'index.html'), `<pre><code${attributes}>hello</code></pre>`);
			await expect(buildWebsite({ sourceDir, outDir })).rejects.toThrow();
			expect(await readFile(join(outDir, 'index.html'), 'utf8')).toBe('previous build');
		}
	} finally {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(outDir, { recursive: true, force: true });
	}
});
