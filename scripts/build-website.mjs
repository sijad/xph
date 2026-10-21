import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeHTML } from 'entities';
import { createHighlighter } from 'shiki';

const root = resolve(import.meta.dirname, '..');

export async function buildWebsite({
	sourceDir = resolve(root, 'website'),
	outDir = resolve(sourceDir, 'dist'),
} = {}) {
	const grammar = JSON.parse(
		await readFile(resolve(root, 'packages/vscode/syntaxes/xph.tmLanguage.json'), 'utf8'),
	);
	const highlighter = await createHighlighter({
		themes: ['github-light', 'github-dark'],
		langs: [
			'typescript',
			'tsx',
			'javascript',
			'css',
			'php',
			'json',
			'shellscript',
			'html',
			grammar,
		],
	});
	try {
		const source = await readFile(resolve(sourceDir, 'index.html'), 'utf8');
		let count = 0;
		const html = source.replace(
			/<pre\b([^>]*)><code\b([^>]*)>([\s\S]*?)<\/code><\/pre>/g,
			(_, preAttributes, codeAttributes, content) => {
				const language = /\bdata-language="([^"]+)"/.exec(codeAttributes)?.[1];
				if (!language) throw new Error(`Missing data-language on example ${count + 1}.`);
				const theme = /\bdata-theme="dark"/.test(codeAttributes) ? 'github-dark' : 'github-light';
				const code = decodeHTML(content);
				const highlighted = highlighter.codeToHtml(code, { lang: language, theme });
				const tokens = /<code>([\s\S]*)<\/code>/.exec(highlighted)?.[1];
				if (tokens === undefined) throw new Error(`Could not highlight example ${count + 1}.`);
				count++;
				return `<pre${preAttributes}><code${codeAttributes}>${tokens}</code></pre>`;
			},
		);
		if (!count) throw new Error('No website examples found.');
		// Finish highlighting before writing, so invalid examples leave the previous build intact.
		await mkdir(outDir, { recursive: true });
		await Promise.all(
			['style.css', 'site.js', 'favicon.svg'].map((file) =>
				copyFile(resolve(sourceDir, file), resolve(outDir, file)),
			),
		);
		await writeFile(resolve(outDir, 'index.html'), html);
		return { outDir, count };
	} finally {
		highlighter.dispose();
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { outDir, count } = await buildWebsite();
	console.log(`Built ${outDir} with ${count} highlighted examples.`);
}
