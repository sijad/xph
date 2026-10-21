import { execFileSync } from 'node:child_process';
import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatAstro } from '../packages/language-server/src/format.js';
import { extractPHP } from '../packages/xph/src/source.js';
import { LanguageServer } from '../packages/language-server/src/index.js';
import { pathToFileURL } from 'node:url';
const options = { tabSize: 2, insertSpaces: true };

it('formats Astro frontmatter, markup, browser scripts and styles while protecting PHP', async () => {
	const source = `---
export interface Props{title:string}
const title="hello"
---
<script server lang="php">
$message = "</script>";
return ['title'=>$message];
</script>
<section><h1>{title}</h1><p class="hint">hello</p></section>
<script>const answer={value:42};console.log(answer)</script>
<style>.hint{color:red;padding:0 1px}</style>`;
	const result = await formatAstro(source, resolve('Format.xph'), options);
	expect(result).toContain('title: string');
	expect(result).toContain('const title = "hello";');
	expect(result).toContain('const answer = { value: 42 };');
	expect(result).toContain('color: red;');
	expect(extractPHP(result).blocks[0].code).toBe(
		'\n  $message = "</script>";\n  return [\'title\'=>$message];\n',
	);
	expect(await formatAstro(result, resolve('Format.xph'), options)).toBe(result);
});

it('honors project Prettier settings and formats without a PHP backend', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-format-'));
	try {
		await mkdir(join(root, 'node_modules'));
		for (const name of ['prettier', 'prettier-plugin-astro'])
			await symlink(resolve('node_modules', name), join(root, 'node_modules', name), 'dir');
		await writeFile(
			join(root, '.prettierrc.json'),
			JSON.stringify({ singleQuote: true, semi: false, plugins: ['prettier-plugin-astro'] }),
		);
		const filename = join(root, 'Page.xph');
		const uri = pathToFileURL(filename).href;
		const server = new LanguageServer(() => {});
		const source =
			'---\nconst title="hello";\n---\n<h1>{title}</h1>\n<script server lang="php">return [];</script>';
		server.documents.set(uri, { text: source, version: 1 });
		const edits: any = await server.query('textDocument/formatting', {
			textDocument: { uri },
			options,
		});
		expect(edits[0].newText).toContain("const title = 'hello'\n");
		expect(edits[0].newText).toContain('<script server lang="php">return [];</script>');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('preserves source and reports missing optional formatter dependencies', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-no-formatter-'));
	try {
		const source = '<div>   unformatted   </div>';
		const result = runFormatter(join(root, 'Page.xph'), source);
		expect(result.text).toBe(source);
		expect(result.messages[0]).toContain('project dependencies');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function runFormatter(filename: string, source: string) {
	const module = pathToFileURL(resolve('packages/language-server/dist/format.js')).href;
	return JSON.parse(
		execFileSync(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
		import { formatAstro } from ${JSON.stringify(module)};
		const messages = [];
		const text = await formatAstro(${JSON.stringify(source)}, ${JSON.stringify(filename)}, { tabSize: 2, insertSpaces: true }, message => messages.push(message));
		console.log(JSON.stringify({ text, messages }));
	`,
			],
			{ encoding: 'utf8' },
		),
	);
}

it('loads the project-owned Prettier and Astro plugin instead of server dependencies', async () => {
	const root = await mkdtemp(join(tmpdir(), 'xph-local-formatter-'));
	try {
		for (const name of ['prettier', 'prettier-plugin-astro']) {
			const directory = join(root, 'node_modules', name);
			await mkdir(directory, { recursive: true });
			await writeFile(
				join(directory, 'package.json'),
				JSON.stringify({ name, type: 'module', main: 'index.js' }),
			);
			await writeFile(
				join(directory, 'index.js'),
				name === 'prettier'
					? `
				export const version = '3.0.0';
				export const resolveConfig = async () => ({});
				export const resolveConfigFile = async () => null;
				export const format = async (text, options) => {
					if (!options.plugins[0].defaultOptions.projectPlugin) throw new Error('Wrong Astro plugin');
					return text + '<!--project formatter and plugin-->';
				};
			`
					: `export const parsers = {}, printers = {}, options = {}, defaultOptions = { projectPlugin: true };`,
			);
		}
		expect(runFormatter(join(root, 'Page.xph'), '<p>test</p>').text).toBe(
			'<p>test</p><!--project formatter and plugin-->',
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('indents multiline PHP with the surrounding markup and preserves literal contents', async () => {
	const source = `<section>
<script server lang="php">
return [
  'heading' => strtoupper(
    $props['title']
  ),
  'literal' => "first
unchanged
last",
  'doc' => <<<'TEXT'
keep this
TEXT,
];
</script>
</section>`;
	const result = await formatAstro(source, resolve('Indent.xph'), options);
	expect(result).toContain(`  <script server lang="php">
    return [
      'heading' => strtoupper(
        $props['title']
      ),`);
	expect(result).toContain(`"first
unchanged
last"`);
	expect(result).toContain(`<<<'TEXT'
keep this
TEXT,`);
	expect(result).toContain('    ];\n  </script>');
	expect(await formatAstro(result, resolve('Indent.xph'), options)).toBe(result);
});

it('uses tabs and CRLF for PHP block indentation', async () => {
	const source = '<script server lang="php">\r\nreturn [\r\n\t1,\r\n];\r\n</script>';
	const result = await formatAstro(source, resolve('Tabs.xph'), {
		tabSize: 4,
		insertSpaces: false,
	});
	expect(result).toContain('\r\n\treturn [\r\n\t\t1,\r\n\t];\r\n</script>');
	expect(await formatAstro(result, resolve('Tabs.xph'), { tabSize: 4, insertSpaces: false })).toBe(
		result,
	);
});
