import { mkdtemp, readFile, readdir, writeFile, cp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const dir = await mkdtemp(join(tmpdir(), 'xph-package-'));
const compiler = JSON.parse(await readFile(join(root, 'packages/xph/package.json'), 'utf8'));
const pnpm = process.env.npm_execpath ?? 'pnpm';
const run = (args, cwd = root) => execFileSync(pnpm, args, { cwd, stdio: 'inherit' });
try {
	run(['--filter', 'xph', 'pack', '--pack-destination', dir]);
	const project = join(dir, 'app');
	await mkdir(project);
	await writeFile(join(project, 'pnpm-workspace.yaml'), 'allowBuilds:\n  esbuild: true\n');
	await writeFile(
		join(project, 'package.json'),
		JSON.stringify({
			private: true,
			type: 'module',
			dependencies: { xph: `file:${join(dir, `${compiler.name}-${compiler.version}.tgz`)}` },
		}),
	);
	run(
		[
			'install',
			...(process.env.XPH_OFFLINE ? ['--offline', '--store-dir', process.env.XPH_STORE] : []),
		],
		project,
	);
	if ((await readdir(join(project, 'node_modules/xph'))).includes('neovim'))
		throw new Error('The xph package must not include the Neovim runtime.');
	await cp(join(root, 'examples/basic/src'), join(project, 'src'), { recursive: true });
	await cp(join(root, 'examples/basic/xph.config.ts'), join(project, 'xph.config.ts'));
	run(['exec', 'xph', 'build'], project);
	execFileSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
const { LanguageServer } = await import('./node_modules/xph/dist/lsp.js');
const server = new LanguageServer(() => {});
const uri = 'file:///xph-package-smoke.xph';
server.documents.set(uri, { text: '<input ', version: 1 });
const completions = await server.query('textDocument/completion', {
  textDocument: { uri }, position: { line: 0, character: 7 },
});
if (!completions?.items.some(item => item.label === 'placeholder'))
  throw new Error('Packed language server did not complete HTML attributes.');
server.documents.set(uri, { text: '<meta charset="utf-8" />', version: 2 });
const definitions = await server.query('textDocument/definition', {
  textDocument: { uri }, position: { line: 0, character: 8 },
});
if (!definitions?.[0]?.uri.endsWith('/xph.d.ts'))
  throw new Error('Packed language server did not resolve native attributes.');
const { readFile } = await import('node:fs/promises');
const declarations = await readFile(new URL(definitions[0].uri), 'utf8');
if (!declarations.split('\\n')[definitions[0].range.start.line].includes('charset?: string | null'))
  throw new Error('Packed native attribute declaration is missing or incorrect.');
const tag = await server.query('textDocument/definition', {
  textDocument: { uri }, position: { line: 0, character: 2 },
});
if (tag?.uri !== definitions[0].uri || !declarations.split('\\n')[tag.range.start.line].includes('meta:'))
  throw new Error('Packed tag and attribute definitions must use the same declaration file.');
try { await import('xph/astro'); throw new Error('xph must not provide an Astro integration'); }
catch (error) { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }
`,
		],
		{ cwd: project, stdio: 'inherit' },
	);
	const php = `require ${JSON.stringify(join(project, 'dist/xph.php'))}; echo \\Xph\\render('src/Page', ['title'=>'Artifact works','items'=>['PHP only']]);`;
	// Remove Node installation before rendering: deployment must use only compiled output.
	await rm(join(project, 'node_modules'), { recursive: true, force: true });
	const html = execFileSync('php', ['-r', php], { encoding: 'utf8' });
	if (!html.includes('ARTIFACT WORKS') || !html.includes('PHP only'))
		throw new Error('Packed artifact rendered incorrect output.');
	console.log(
		'Packed compiler rendered with PHP after removing node_modules; Astro integration is absent.',
	);
} finally {
	await rm(dir, { recursive: true, force: true });
}
