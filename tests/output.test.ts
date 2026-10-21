import { it, expect } from 'vitest';
import { compile } from '../packages/xph/src/index.js';
import { createRequire } from 'node:module';

it('does not expose an Astro integration from the compiler package', () => {
	const require = createRequire(new URL('../packages/xph/package.json', import.meta.url));
	expect(() => require.resolve('xph/astro')).toThrow(
		'Package subpath \'./astro\' is not defined by "exports"',
	);
});
it('snapshots generated PHP alongside the execution regressions', async () => {
	const result = await compile(
		'---\nexport interface Props { title: string }\n---\n<h1>{props.title}</h1>',
		{ filename: 'Snapshot.xph' },
	);
	expect(result.diagnostics).toEqual([]);
	expect(result.php).toMatchSnapshot();
});
it('reports unsupported constant crossings without throwing', async () => {
	const result = await compile('---\nconst fn = () => 1;\n---\n<div title={fn} />');
	expect(result.diagnostics.length).toBeGreaterThan(0);
});
it('uses build helpers without serializing them', async () => {
	const result = await compile(
		'---\nconst helper = () => "built";\nconst title = helper();\n---\n{title}',
	);
	expect(result.diagnostics).toEqual([]);
	expect(result.php).toContain('>built<?php');
	expect(result.php).not.toContain('$constants');
	expect(result.php).not.toContain("'helper' =>");
});
it.each([
	'<div>',
	'{props.',
	'---\nexport interface Props {x:}\n---\n<p/>',
	'<script is:server>return [',
])('recovers from malformed source %s', async (source) => {
	await expect(compile(source)).resolves.toHaveProperty('diagnostics');
});
it('extracts native blocks following styles and browser scripts', async () => {
	const result = await compile(
		'<style>p {color: red}</style><script is:server>return [];</SCRIPT><p/>',
	);
	expect(result.diagnostics).toEqual([]);
	expect(result.php).toContain('return [];');
});
it('does not mistake quoted attributes for a server directive', async () => {
	const result = await compile('<script title=" server ">console.log(1)</script>');
	expect(result.diagnostics.some((d) => d.message.includes('lang="php"'))).toBe(false);
});
