import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { beforeAll, expect, it } from 'vitest';
import textmate from 'vscode-textmate';
import oniguruma from 'vscode-oniguruma';

const require = createRequire(import.meta.url);
let grammar: textmate.IGrammar;
beforeAll(async () => {
	await oniguruma.loadWASM(await readFile(require.resolve('vscode-oniguruma/release/onig.wasm')));
	const source = JSON.parse(
		await readFile(
			new URL('../packages/vscode/syntaxes/xph.tmLanguage.json', import.meta.url),
			'utf8',
		),
	);
	const registry = new textmate.Registry({
		onigLib: Promise.resolve(oniguruma),
		loadGrammar: async (scopeName) => {
			if (scopeName === 'source.xph') return source;
			// Stand-ins isolate the embedding boundaries from VS Code's bundled grammars.
			return { scopeName, patterns: [{ match: '.', name: `test.embedded.${scopeName}` }] };
		},
	});
	grammar = (await registry.loadGrammar('source.xph'))!;
});
function tokenize(source: string) {
	let state = textmate.INITIAL;
	return source.split('\n').map((line) => {
		const result = grammar.tokenizeLine(line, state);
		state = result.ruleStack;
		return result.tokens.map((token) => ({
			text: line.slice(token.startIndex, token.endIndex),
			scopes: token.scopes,
		}));
	});
}

it.each([
	'<script is:server>',
	'<script id="setup" is:server>',
	'<script is:server id="setup">',
	'<script\n is:server\n>',
])('embeds tagless PHP after %s and returns to markup', (opening) => {
	const lines = tokenize(`${opening}\n$title = "Hello";\n</script>\n<h1>{server.title}</h1>`);
	const php = lines.at(-3)!;
	expect(php.some((token) => token.scopes.includes('test.embedded.source.php'))).toBe(true);
	expect(lines.at(-1)!.every((token) => !token.scopes.includes('source.php'))).toBe(true);
	expect(lines.at(-1)!.some((token) => token.scopes.includes('entity.name.tag.astro'))).toBe(true);
});
it('embeds PHP in a single-line block and closes before following markup', () => {
	const [tokens] = tokenize('<script is:server>return [];</script><p>Hi</p>');
	expect(tokens.some((token) => token.scopes.includes('source.php'))).toBe(true);
	expect(
		tokens.some(
			(token) =>
				token.text === 'p' &&
				token.scopes.includes('entity.name.tag.astro') &&
				!token.scopes.includes('source.php'),
		),
	).toBe(true);
});
it('retains Astro frontmatter, expressions, scripts, and style embeddings', () => {
	const lines = tokenize(
		'---\nconst title: string = "hi";\n---\n<h1>{title}</h1>\n<script>\nconsole.log(title);\n</script>\n<style>\nh1 { color: red }\n</style>',
	);
	for (const [line, scope] of [
		[1, 'source.ts'],
		[3, 'source.tsx'],
		[5, 'source.js'],
		[8, 'source.css'],
	] as const)
		expect(lines[line].some((token) => token.scopes.includes(scope))).toBe(true);
});
