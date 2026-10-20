import { mkdtemp, readFile, readdir, writeFile, cp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const dir = await mkdtemp(join(tmpdir(), 'xph-package-'));
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
			dependencies: { xph: `file:${join(dir, 'xph-0.1.0.tgz')}` },
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
	await writeFile(
		join(project, 'astro-smoke.mjs'),
		`
import xph from 'xph/astro';
import { pathToFileURL } from 'node:url';
const integration = xph({ entries: ['src/Page.xph'] });
const url = path => new URL(path, pathToFileURL(process.cwd() + '/'));
integration.hooks['astro:config:done']({config:{root:url('./'),outDir:url('./astro-dist/'),cacheDir:url('./.astro/'),base:'/site/'}});
await integration.hooks['astro:build:done']({dir:url('./astro-dist/'),logger:{info:()=>{},error:()=>{}}});
`,
	);
	execFileSync(process.execPath, [join(project, 'astro-smoke.mjs')], {
		cwd: project,
		stdio: 'inherit',
	});
	const php = `require ${JSON.stringify(join(project, 'dist/xph.php'))}; echo \\Xph\\render('src/Page', ['title'=>'Artifact works','items'=>['PHP only']]);`;
	// Remove Node installation before rendering: deployment must use only compiled output.
	await rm(join(project, 'node_modules'), { recursive: true, force: true });
	const html = execFileSync('php', ['-r', php], { encoding: 'utf8' });
	if (!html.includes('ARTIFACT WORKS') || !html.includes('PHP only'))
		throw new Error('Packed artifact rendered incorrect output.');
	const integrated = execFileSync(
		'php',
		[
			'-r',
			`require ${JSON.stringify(join(project, 'astro-dist/xph/xph.php'))}; echo \\Xph\\render('src/Page', ['title'=>'Integration works','items'=>[]]);`,
		],
		{ encoding: 'utf8' },
	);
	if (!integrated.includes('INTEGRATION WORKS'))
		throw new Error('Packed Astro integration rendered incorrect output.');
	console.log(
		'Packed artifact and Astro integration built and rendered with PHP after removing node_modules.',
	);
} finally {
	await rm(dir, { recursive: true, force: true });
}
