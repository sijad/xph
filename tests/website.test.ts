import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decodeHTML } from 'entities';
import { expect, it } from 'vitest';
import { buildWebsite } from '../scripts/build-website.mjs';

const examples = (html: string) =>
	[...html.matchAll(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((match) =>
		decodeHTML(match[1].replace(/<[^>]+>/g, '')),
	);

it('builds the website with highlighted examples while preserving their exact text and assets', async () => {
	const outDir = await mkdtemp(join(tmpdir(), 'xph-website-'));
	const source = await readFile(resolve('website/index.html'), 'utf8');
	try {
		const { count } = await buildWebsite({ outDir });
		const html = await readFile(join(outDir, 'index.html'), 'utf8');
		expect(count).toBe(examples(source).length);
		expect(count).toBeGreaterThan(0);
		expect(examples(html)).toEqual(examples(source));
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
