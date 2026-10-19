import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('preview.php', import.meta.url), 'utf8');
await writeFile(
	new URL('dist/index.php', import.meta.url),
	source.replace("'/dist/xph.php'", "'/xph.php'"),
);
