import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acfFile } from '../packages/xph-wordpress/src/acf-registration.js';
import { build } from '../packages/xph-wordpress/src/build.js';
import { compile } from '../packages/xph/src/index.js';
const exec = promisify(execFile);
const acfModule = JSON.stringify(
	fileURLToPath(new URL('../packages/xph-wordpress/src/acf.ts', import.meta.url)),
);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'xph-acf-')));
	roots.push(root);
	await mkdir(join(root, 'src'), { recursive: true });
	return root;
}
const generate = (root: string) => acfFile({ root, srcDir: join(root, 'src') });
const errors = async (root: string) =>
	(await build({ root, outDir: 'theme' })).diagnostics
		.filter((d) => d.severity === 'error')
		.map((d) => d.message);
const location = `[[{ param: 'page_template', operator: '==', value: 'landing.php' }]]`;
const fieldsModule = `import { createAcfField, createAcfGroup } from ${acfModule};
export const heroField = createAcfField({ type: 'group', name: 'hero', label: 'Hero', sub_fields: [{ type: 'text', name: 'title', label: 'Title' }] });
export const landing = createAcfGroup({ key: 'landing_page', title: 'Landing', location: ${location}, fields: [heroField, heroField.withSuffix('2')] });
export const site = createAcfGroup({ key: 'site_options', title: 'Site', location: [[{ param: 'options_page', operator: '==', value: 'site' }]], fields: [{ type: 'text', name: 'tagline', label: 'Tagline' }] });`;

it('registers the groups src/acf.ts exports, once each', async () => {
	const root = await project();
	expect(await generate(root)).toBeUndefined();
	await writeFile(join(root, 'src/acf.ts'), fieldsModule);
	const output = (await generate(root))!;
	expect(output).toMatch(/^<\?php\nif\( function_exists\('acf_add_local_field_group'\) \)/);
	// Field exports are not groups, so only the two groups are registered.
	expect(output.match(/acf_add_local_field_group\(\[/g)).toHaveLength(2);
	expect(output).toContain("'name' => 'hero_2'");
	expect(output.match(/function xph_acf_group\(/g)).toHaveLength(1);
	// The PHP language server completes the registered keys.
	expect(output).toContain("/** @param 'landing_page'|'site_options' $key */");
});

it('rejects duplicate keys and groups without a location', async () => {
	const root = await project();
	await writeFile(join(root, 'src/acf.ts'), `${fieldsModule}\nexport const again = landing;`);
	await expect(generate(root)).rejects.toThrow(
		'ACF group "landing_page" is exported twice by src/acf.ts.',
	);
	await writeFile(
		join(root, 'src/acf.ts'),
		`import { createAcfGroup } from ${acfModule};\nexport const home = createAcfGroup({ key: 'home', title: 'Home', fields: [] });`,
	);
	await expect(generate(root)).rejects.toThrow('ACF group "home" in src/acf.ts needs a location.');
});

it('runs the fields module with Node globals and reuses it until an input changes', async () => {
	const root = await project();
	await writeFile(
		join(root, 'src/acf.ts'),
		`import { createAcfGroup } from ${acfModule};
const title = new URL('https://example.com/' + __dirname.split('/').pop()).pathname.slice(1);
export const home = createAcfGroup({ key: 'home', title: structuredClone(title), location: ${location}, fields: [] });`,
	);
	const first = await generate(root);
	expect(first).toContain("'title' => 'src'");
	expect(await generate(root)).toEqual(first);
	await writeFile(join(root, 'src/acf.ts'), fieldsModule);
	expect(await generate(root)).toContain("'key' => 'site_options'");
});

it('rejects server scripts that load a group the fields module does not export', async () => {
	const root = await project();
	await mkdir(join(root, 'src/theme'));
	await writeFile(join(root, 'src/acf.ts'), fieldsModule);
	await writeFile(
		join(root, 'src/theme/landing.xph'),
		`---
export const template = 'Landing';
---
<script is:server>
	return ['page' => xph_acf_group('landing')];
</script>
<p>Landing</p>`,
	);
	await writeFile(join(root, 'src/theme/style.css'), '/* Theme Name: ACF test */');
	expect(await errors(root)).toEqual([
		'src/theme/landing.xph: ACF group "landing" is not exported by src/acf.ts.',
	]);
});

it('loads registered groups in server scripts, typed with AcfServer', async () => {
	const root = await project();
	await mkdir(join(root, 'src/components'));
	await mkdir(join(root, 'src/theme'));
	await writeFile(join(root, 'src/acf.ts'), fieldsModule);
	await writeFile(
		join(root, 'src/components/Hero.xph'),
		`---
import type { AcfValue } from ${acfModule};
import type { heroField } from '../acf';
export interface Props {
	hero: AcfValue<typeof heroField>;
}
---
<h1>{props.hero.title}</h1>`,
	);
	await writeFile(
		join(root, 'src/theme/landing.xph'),
		`---
import type { AcfServer } from ${acfModule};
import Hero from '../components/Hero.xph';
import type { landing, site } from '../acf';
export const template = 'Landing';
export interface Server {
	page: AcfServer<typeof landing>;
	site: AcfServer<typeof site>;
}
---
<script is:server>
	return ['page' => xph_acf_group('landing_page'), 'site' => xph_acf_group('site_options', 'options')];
</script>
<Hero hero={server.page.hero} />
<Hero hero={server.page.hero_2} />
<p>{server.site.tagline}</p>`,
	);
	await writeFile(join(root, 'src/theme/style.css'), '/* Theme Name: ACF test */');
	expect(await errors(root)).toEqual([]);
	const out = join(root, 'theme');
	expect(await readFile(join(out, 'register.php'), 'utf8')).toContain(
		"require_once __DIR__ . '/acf.generated.php';",
	);
	const { stdout } = await exec('php', [
		'-r',
		`
function add_action($name, $callback) { $GLOBALS['hooks'][$name][] = $callback; }
function get_theme_file_uri($path) { return $path; }
function acf_add_local_field_group($group) { $GLOBALS['groups'][$group['key']] = $group['fields']; }
function acf_get_fields($key) { return $GLOBALS['groups'][$key] ?? false; }
function get_field($name, $post, $format) {
	if ($format !== true) throw new Exception('unformatted read of ' . $name);
	return [
		'hero' => ['title' => 'Hello &'],
		'hero_2' => ['title' => 'Again'],
		'tagline' => $post === 'options' ? 'From options' : 'From the page',
	][$name];
}
require $argv[1] . '/functions.php';
foreach ($GLOBALS['hooks']['init'] ?? [] as $callback) $callback();
require $argv[1] . '/landing.php';
echo json_encode(xph_acf_group('missing'));`,
		out,
	]);
	expect(stdout).toContain('<h1>Hello &amp;</h1>');
	expect(stdout).toContain('<h1>Again</h1>');
	expect(stdout).toContain('<p>From options</p>');
	expect(stdout.endsWith('[]')).toBe(true);
});

it('type-checks values typed with AcfServer', async () => {
	const root = await project();
	await writeFile(join(root, 'src/acf.ts'), fieldsModule);
	const result = await compile(
		`---
import type { AcfServer } from ${acfModule};
import type { landing } from './acf';
export interface Server {
	page: AcfServer<typeof landing>;
}
---
<script is:server>
	return ['page' => xph_acf_group('landing_page')];
</script>
<p>{server.page.hero_2.title} {server.page.hero.titel}</p>`,
		{ filename: join(root, 'src/Page.xph') },
	);
	const errors = result.diagnostics.filter((d) => d.source === 'typescript');
	expect(errors).toHaveLength(1);
	expect(errors[0].message).toMatch(/'titel'/);
});

it('registers groups for block plugins too', async () => {
	const root = await project();
	await writeFile(join(root, 'src/acf.ts'), fieldsModule);
	const helper = JSON.stringify(
		fileURLToPath(new URL('../packages/xph-wordpress/src/index.ts', import.meta.url)),
	);
	await writeFile(
		join(root, 'src/Card.xph'),
		`---\nimport { defineBlock } from ${helper};\nexport const block = defineBlock({ name: 'test/card', title: 'Card' });\n---\n<p>Card</p>`,
	);
	expect(await errors(root)).toEqual([]);
	expect(await readFile(join(root, 'theme/register.php'), 'utf8')).toContain(
		"require_once __DIR__ . '/acf.generated.php';",
	);
});
