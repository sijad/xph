import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { format } from 'prettier';

const directory = fileURLToPath(new URL('.', import.meta.url));
const entry = resolve(
	process.env.BENCH_XPH_ENTRY ?? join(directory, '../packages/xph/dist/index.js'),
);
const { build, createBuilder } = await import(pathToFileURL(entry).href);
const samples = Number(process.env.BENCH_SAMPLES ?? 7);
const iterations = Number(process.env.BENCH_PROJECT_ITERATIONS ?? 3);
const renders = Number(process.env.BENCH_RENDERS ?? 1000);
for (const value of [samples, iterations, renders])
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error('Benchmark counts must be positive integers');
const php = process.env.PHP ?? 'php';
const phpArgs = ['-d', 'opcache.enable_cli=1', '-d', 'opcache.file_update_protection=0'];
const root = await mkdtemp(join(tmpdir(), 'xph-project-bench-'));
const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const checked = (result) => {
	if (result.diagnostics.some((d) => d.severity === 'error'))
		throw new Error(JSON.stringify(result.diagnostics));
	return result;
};
const measure = async (operation, count) => {
	const start = performance.now();
	for (let i = 0; i < count; i++) await operation();
	return ((performance.now() - start) * 1000) / count;
};
try {
	await mkdir(join(root, 'src'));
	const label = (text = '') =>
		`---\ninterface Props { text: string }\n---\n<h2>${text}{props.text}</h2>`;
	const sources = {
		'Theme.xph': '<style is:global>article { display: block }</style>',
		'Label.xph': label(),
		'Card.xph':
			'---\nimport Label from "./Label.xph";\ninterface Props { id: number; title: string }\n---\n<article data-id={props.id}><Label text={props.title}/><slot/></article>',
		'Layout.xph': '<main><slot/></main>',
		'Page.xph':
			'---\nimport Theme from "./Theme.xph";\nimport Layout from "./Layout.xph";\nimport Card from "./Card.xph";\ninterface Props { items: { id: number; title: string }[] }\n---\n<Theme/><Layout>{props.items.map(item => <Card id={item.id} title={item.title}><p>{item.title}</p></Card>)}</Layout>',
	};
	for (const [name, source] of Object.entries(sources))
		await writeFile(join(root, 'src', name), source);
	const data = {
		items: Array.from({ length: 100 }, (_, id) => ({ id, title: `Item <${id}> & value` })),
	};
	const escaped = (text) =>
		text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
	const expected = `<main>${data.items.map((item) => `<article data-id="${item.id}"><h2>${escaped(item.title)}</h2><p>${escaped(item.title)}</p></article>`).join('')}</main>`;
	await writeFile(join(root, 'fixture.json'), JSON.stringify({ data, expected }));
	const config = { root, debug: false, php };
	checked(await build(config));
	const rebuild = createBuilder(config);
	checked(await rebuild());
	let edit = 0;
	const operations = {
		'full-build': async () => checked(await build(config)),
		'noop-rebuild': async () => checked(await rebuild()),
		'leaf-edit-rebuild': async () => {
			await writeFile(join(root, 'src/Label.xph'), label(++edit % 2 ? 'Updated ' : ''));
			checked(await rebuild());
		},
	};
	const builds = Object.fromEntries(Object.keys(operations).map((name) => [name, []]));
	for (let sample = 0; sample < samples; sample++) {
		const names = Object.keys(operations);
		const offset = sample % names.length;
		for (const name of [...names.slice(offset), ...names.slice(0, offset)])
			builds[name].push(await measure(operations[name], iterations));
	}
	await writeFile(join(root, 'src/Label.xph'), label());
	checked(await rebuild());
	const cold = { 'compiler-process': [], 'build-process': [], 'php-request-process': [] };
	for (let sample = 0; sample < samples; sample++) {
		for (const operation of ['compile', 'build']) {
			const time = await measure(
				() =>
					execFileSync(
						process.execPath,
						[join(directory, 'project-worker.mjs'), entry, operation, root],
						{ encoding: 'utf8', env: { ...process.env, PHP: php } },
					),
				1,
			);
			cold[operation === 'compile' ? 'compiler-process' : 'build-process'].push(time);
		}
		cold['php-request-process'].push(
			await measure(
				() =>
					execFileSync(php, [...phpArgs, join(directory, 'project.php'), root, 'cold', '1', '1'], {
						encoding: 'utf8',
					}),
				1,
			),
		);
	}
	const runtime = JSON.parse(
		execFileSync(
			php,
			[...phpArgs, join(directory, 'project.php'), root, 'warm', String(samples), String(renders)],
			{ encoding: 'utf8' },
		),
	);
	const lookups = JSON.parse(
		execFileSync(php, [...phpArgs, join(directory, 'lookups.php'), String(samples)], {
			encoding: 'utf8',
		}),
	);
	const results = {
		environment: { node: process.version, php: runtime.php, cpu: cpus()[0]?.model },
		settings: {
			samples,
			iterations,
			renders,
			components: Object.keys(sources).length,
			items: data.items.length,
			phpCheck: true,
			write: true,
			debug: false,
		},
		cold,
		builds,
		render: runtime.results,
		lookups,
	};
	const tables =
		Object.entries({ 'Cold processes': cold, Builds: builds, Rendering: runtime.results })
			.map(([title, rows]) =>
				[
					`## ${title}`,
					'',
					'| Operation | Median µs/op |',
					'| --- | ---: |',
					...Object.entries(rows).map(
						([name, times]) => `| ${name} | ${median(times).toFixed(2)} |`,
					),
				].join('\n'),
			)
			.join('\n\n') +
		'\n\n' +
		[
			'## Runtime membership lookups',
			'',
			'| Literal list | in_array µs/op | isset µs/op |',
			'| --- | ---: | ---: |',
			...Object.entries(lookups).map(
				([name, timings]) =>
					`| ${name} | ${median(timings.in_array).toFixed(4)} | ${median(timings.isset).toFixed(4)} |`,
			),
		].join('\n');
	console.log(tables);
	const output = resolve(
		process.env.BENCH_PROJECT_OUTPUT ?? join(directory, 'project-results.json'),
	);
	await writeFile(
		output,
		await format(JSON.stringify(results), { parser: 'json', useTabs: true, printWidth: 100 }),
	);
	if (!process.env.BENCH_PROJECT_OUTPUT)
		await writeFile(
			join(directory, 'PROJECT.md'),
			await format(
				`# Project benchmarks\n\n${tables}\n\nFive components render 100 cards with nested component calls, default slots, numeric attributes, and escaped text. Renderer measurements include dependency asset collection and stylesheet emission. Builds include output writes and PHP syntax checks for every component. Leaf edits include the source write; unchanged importers are reused. Cold timings include process startup and module loading; filesystem caches may be warm. PHP CLI OPcache is enabled but its cache is not shared between processes. These are CLI request proxies, not HTTP/FPM latency measurements.\n\n${results.environment.cpu} · PHP ${runtime.php} · Node ${process.version}.\n\nRun with \`pnpm bench:project\`. Control counts with \`BENCH_SAMPLES\`, \`BENCH_PROJECT_ITERATIONS\`, and \`BENCH_RENDERS\`.\n\n[Raw results](project-results.json)\n`,
				{ parser: 'markdown', useTabs: true, printWidth: 100 },
			),
		);
} finally {
	await rm(root, { recursive: true, force: true });
}
