import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { markerPattern, type PhpRender } from './astro-renderer.js';
import { phpLiteral as literal } from './contracts.js';

/** Convert only pages containing xph render markers; ordinary Astro output stays static. */
export async function emitPhpPages(output: string, directory: string) {
	async function visit(folder: string): Promise<void> {
		for (const entry of await readdir(folder, { withFileTypes: true })) {
			const file = join(folder, entry.name);
			if (entry.isDirectory()) {
				await visit(file);
				continue;
			}
			if (!entry.name.endsWith('.html')) continue;
			const html = await readFile(file, 'utf8');
			if (!html.match(markerPattern)) continue;
			const phpTemplate = entry.name.endsWith('.php.html');
			const components = new Set<string>();
			function expression(payload: string): string {
				const render = JSON.parse(Buffer.from(payload, 'base64').toString()) as PhpRender;
				components.add(render.id);
				let slot = 'null';
				if (render.slot !== undefined) {
					if (phpTemplate) {
						const content = render.slot.replace(
							markerPattern,
							(_match, payload) => `<?php echo ${expression(payload)}; ?>`,
						);
						slot = `static function (): string { ob_start(); ?>${content}<?php return ob_get_clean(); }`;
					} else {
						const pieces: string[] = [];
						let offset = 0;
						for (const match of render.slot.matchAll(markerPattern)) {
							pieces.push(literal(render.slot.slice(offset, match.index)), expression(match[1]));
							offset = match.index + match[0].length;
						}
						pieces.push(literal(render.slot.slice(offset)));
						slot = `static fn() => ${pieces.join(' . ')}`;
					}
				}
				return `\\Xph\\render(${literal(render.id)}, json_decode(${literal(JSON.stringify(render.props))}, true, 512, JSON_THROW_ON_ERROR), ${slot})`;
			}
			// Static HTML can contain PHP-looking user content; keep it literal on the PHP server.
			const body = (phpTemplate ? html : html.replace(/<\?/g, "<?='<?'?>")).replace(
				markerPattern,
				(_match, payload) => `<?php echo ${expression(payload)}; ?>`,
			);
			const runtime = relative(dirname(file), join(output, directory, 'xph.php'))
				.split(sep)
				.join('/');
			const ids = JSON.stringify([...components]);
			const bootstrap = `<?php\nrequire_once __DIR__ . '/' . ${literal(runtime)};\n$xph_assets = [];\nforeach (json_decode(${literal(ids)}, true) as $xph_component) {\n foreach (\\Xph\\assets($xph_component) as $xph_asset) {\n  if (isset($xph_assets[$xph_asset['url']])) continue;\n  $xph_assets[$xph_asset['url']] = true;\n  $xph_url = htmlspecialchars($xph_asset['url'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');\n  echo $xph_asset['type'] === 'css' ? '<link rel="stylesheet" href="' . $xph_url . '">' : '<script type="module" src="' . $xph_url . '"></script>';\n }\n}\n?>`;
			// Keep the document doctype first; asset tags belong inside the head when available.
			const start = `<?php require_once __DIR__ . '/' . ${literal(runtime)}; ?>`;
			const page = /<\/head\s*>/i.test(body)
				? start + body.replace(/<\/head\s*>/i, () => bootstrap + '</head>')
				: bootstrap + body;
			// PHP adapters own the final rename and track the original .php.html paths.
			if (phpTemplate) {
				await writeFile(file, page);
				continue;
			}
			const target = file.slice(0, -5) + '.php';
			try {
				await writeFile(target, page, { flag: 'wx' });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EEXIST')
					throw new Error(`Refusing to overwrite existing PHP page: ${target}`);
				throw error;
			}
			await unlink(file);
		}
	}
	await visit(output);
}
