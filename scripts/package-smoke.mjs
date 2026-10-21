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
	const workspace = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
	await writeFile(
		join(project, 'package.json'),
		JSON.stringify({
			private: true,
			type: 'module',
			dependencies: { xph: `file:${join(dir, `${compiler.name}-${compiler.version}.tgz`)}` },
			pnpm: workspace.pnpm,
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
