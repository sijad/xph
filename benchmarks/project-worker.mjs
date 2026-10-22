// A separate process intentionally includes module loading and compiler startup.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [entry, operation, root] = process.argv.slice(2);
const { compile, build } = await import(pathToFileURL(entry).href);
const result =
	operation === 'compile'
		? await compile(await readFile(`${root}/src/Label.xph`, 'utf8'), {
				filename: `${root}/src/Label.xph`,
			})
		: await build({ root, debug: false, php: process.env.PHP ?? 'php' });
if (result.diagnostics.some((d) => d.severity === 'error'))
	throw new Error(JSON.stringify(result.diagnostics));
console.log(JSON.stringify({ php: process.env.PHP ?? 'php', node: process.version }));
