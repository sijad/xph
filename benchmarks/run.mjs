import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { format } from 'prettier';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { compile } from '../packages/xph/dist/index.js';
import { phpLiteral } from '../packages/xph/dist/contracts.js';

const root = fileURLToPath(new URL('.', import.meta.url));
await access(join(root, 'vendor/autoload.php')).catch(() => {
	throw new Error('Install Blade and Twig first: composer install --working-dir=benchmarks');
});
const xphVersion = JSON.parse(
	await readFile(new URL('../packages/xph/package.json', import.meta.url), 'utf8'),
).version;
const iterations = Number(process.env.BENCH_ITERATIONS ?? 100);
const samples = Number(process.env.BENCH_SAMPLES ?? 7);
const renders = Number(process.env.BENCH_RENDERS ?? 1000);
for (const value of [iterations, samples, renders]) {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error('Benchmark counts must be positive integers');
}
const fixtures = [
	{
		name: 'static',
		xph: '<main><h1>Hello world</h1><p>A static page.</p></main>',
		blade: '<main><h1>Hello world</h1><p>A static page.</p></main>',
		twig: '<main><h1>Hello world</h1><p>A static page.</p></main>',
		data: {},
	},
	{
		name: 'escaped',
		xph: '---\nexport interface Props { title: string; body: string; }\n---\n<article><h1>{props.title}</h1><p>{props.body}</p></article>',
		blade: '<article><h1>{{ $title }}</h1><p>{{ $body }}</p></article>',
		twig: '<article><h1>{{ title }}</h1><p>{{ body }}</p></article>',
		data: { title: 'Hello <world> & "friends"', body: "Text with <tags>, & and 'quotes'." },
	},
	{
		name: 'list-100',
		xph: '---\nexport interface Props { items: { name: string; active: boolean }[]; }\n---\n<ul>{props.items.map(item => <li>{item.active ? <strong>{item.name}</strong> : <span>{item.name}</span>}</li>)}</ul>',
		blade:
			'<ul>@foreach ($items as $item)<li>@if ($item["active"])<strong>{{ $item["name"] }}</strong>@else<span>{{ $item["name"] }}</span>@endif</li>@endforeach</ul>',
		twig: '<ul>{% for item in items %}<li>{% if item.active %}<strong>{{ item.name }}</strong>{% else %}<span>{{ item.name }}</span>{% endif %}</li>{% endfor %}</ul>',
		data: {
			items: Array.from({ length: 100 }, (_, i) => ({
				name: `Item <${i}> & value`,
				active: i % 2 === 0,
			})),
		},
	},
	{
		name: 'control-flow-100',
		xph: '---\nexport interface Props { items: { name: string; status: number }[]; }\n---\n<ul>{props.items.map(item => <li>{item.status === 0 ? <strong>{item.name}</strong> : item.status === 1 ? <span>{item.name}</span> : <em>{item.name}</em>}</li>)}</ul>',
		blade:
			'<ul>@foreach ($items as $item)<li>@if ($item["status"] === 0)<strong>{{ $item["name"] }}</strong>@elseif ($item["status"] === 1)<span>{{ $item["name"] }}</span>@else<em>{{ $item["name"] }}</em>@endif</li>@endforeach</ul>',
		twig: '<ul>{% for item in items %}<li>{% if item.status == 0 %}<strong>{{ item.name }}</strong>{% elseif item.status == 1 %}<span>{{ item.name }}</span>{% else %}<em>{{ item.name }}</em>{% endif %}</li>{% endfor %}</ul>',
		data: {
			items: Array.from({ length: 100 }, (_, i) => ({
				name: `Item <${i}> & value`,
				status: i % 3,
			})),
		},
	},
	{
		name: 'dashboard-nested',
		xph: '---\nexport interface Props {\n title: string;\n groups: { id: string; name: string; items: { name: string; href: string; active: boolean; featured: boolean; tags: string[] }[] }[];\n}\n---\n<main><h1>{props.title}</h1>{props.groups.map(group => <section id={group.id}><h2>{group.name}</h2>{group.items.length === 0 ? <p>No items</p> : <ul>{group.items.map(item => <li class={item.active ? "active" : "inactive"}><a href={item.href} title={item.name}>{item.featured ? <strong>{item.name}</strong> : <span>{item.name}</span>}</a>{item.active ? <b>Available</b> : <i>Unavailable</i>}<div>{item.tags.map(tag => <small>{tag}</small>)}</div></li>)}</ul>}</section>)}</main>',
		blade:
			"<main><h1>{{ $title }}</h1>@foreach ($groups as $group)<section id=\"{{ $group['id'] }}\"><h2>{{ $group['name'] }}</h2>@if (count($group['items']) === 0)<p>No items</p>@else<ul>@foreach ($group['items'] as $item)<li class=\"{{ $item['active'] ? 'active' : 'inactive' }}\"><a href=\"{{ $item['href'] }}\" title=\"{{ $item['name'] }}\">@if ($item['featured'])<strong>{{ $item['name'] }}</strong>@else<span>{{ $item['name'] }}</span>@endif</a>@if ($item['active'])<b>Available</b>@else<i>Unavailable</i>@endif<div>@foreach ($item['tags'] as $tag)<small>{{ $tag }}</small>@endforeach</div></li>@endforeach</ul>@endif</section>@endforeach</main>",
		twig: '<main><h1>{{ title }}</h1>{% for group in groups %}<section id="{{ group.id }}"><h2>{{ group.name }}</h2>{% if group.items|length == 0 %}<p>No items</p>{% else %}<ul>{% for item in group.items %}<li class="{{ item.active ? \'active\' : \'inactive\' }}"><a href="{{ item.href }}" title="{{ item.name }}">{% if item.featured %}<strong>{{ item.name }}</strong>{% else %}<span>{{ item.name }}</span>{% endif %}</a>{% if item.active %}<b>Available</b>{% else %}<i>Unavailable</i>{% endif %}<div>{% for tag in item.tags %}<small>{{ tag }}</small>{% endfor %}</div></li>{% endfor %}</ul>{% endif %}</section>{% endfor %}</main>',
		data: {
			title: 'Dashboard <overview> & activity',
			groups: Array.from({ length: 10 }, (_, group) => ({
				id: `group-${group}`,
				name: `Group <${group}> & team`,
				items: Array.from({ length: group % 4 === 0 ? 0 : 20 }, (_, item) => ({
					name: `Item "${item}" <details> & notes`,
					href: `/items/${group}/${item}?view=full&sort=name`,
					active: item % 3 !== 0,
					featured: item % 5 === 0,
					tags: Array.from({ length: 3 }, (_, tag) => `Tag <${tag}> & label`),
				})),
			})),
		},
	},
];
const directory = await mkdtemp(join(tmpdir(), 'xph-template-bench-'));
const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
try {
	const manifest = {};
	const compilation = {};
	for (const fixture of fixtures) {
		const options = { debug: false, filename: resolve(directory, `${fixture.name}.xph`) };
		const compileChecked = async () => {
			const result = await compile(fixture.xph, options);
			if (result.diagnostics.some((d) => d.severity === 'error'))
				throw new Error(JSON.stringify(result.diagnostics));
			return result;
		};
		const result = await compileChecked();
		await writeFile(join(directory, `${fixture.name}.php`), result.php);
		await writeFile(join(directory, `${fixture.name}.blade.php`), fixture.blade);
		await writeFile(join(directory, `${fixture.name}.html.twig`), fixture.twig);
		manifest[fixture.name] = { file: `${fixture.name}.php`, assets: [], dependencies: [] };
		for (let i = 0; i < 10; i++) await compileChecked();
		const times = [];
		for (let s = 0; s < samples; s++) {
			const start = performance.now();
			for (let i = 0; i < iterations; i++) await compileChecked();
			times.push(((performance.now() - start) * 1000) / iterations);
		}
		compilation[fixture.name] = times;
	}
	await writeFile(
		join(directory, 'manifest.php'),
		'<?php return ' +
			phpLiteral({
				components: manifest,
				assets: Object.fromEntries(Object.keys(manifest).map((id) => [id, []])),
			}) +
			';\n',
	);
	await writeFile(join(directory, 'fixtures.json'), JSON.stringify(fixtures));
	const php = JSON.parse(
		execFileSync(
			process.env.PHP ?? 'php',
			[
				'-d',
				'opcache.enable_cli=1',
				'-d',
				'opcache.file_update_protection=0',
				join(root, 'run.php'),
				directory,
				String(iterations),
				String(samples),
				String(renders),
			],
			{ encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
		),
	);
	const results = {
		environment: {
			node: process.version,
			xph: xphVersion,
			cpu: cpus()[0]?.model,
			...php.environment,
		},
		settings: { iterations, samples, renders, warmup: 10, debug: false, phpCheck: false },
		fixtures: fixtures.map((f) => ({
			name: f.name,
			bytes: php.results[f.name].bytes,
			compile: { xph: compilation[f.name], ...php.results[f.name].compile },
			render: php.results[f.name].render,
		})),
	};
	console.log(JSON.stringify(results.environment));
	console.log(
		`Median microseconds/op; ${samples} samples, ${iterations} compiles, ${renders} renders per sample. Lower is better.`,
	);
	const tables = ['compile', 'render']
		.map((stage) =>
			[
				`## ${stage === 'compile' ? 'Compilation' : 'Rendering'}`,
				'',
				'| Fixture | xph | Blade | Twig | Fastest | Less time than others |',
				'| --- | ---: | ---: | ---: | --- | --- |',
				...results.fixtures.map((fixture) => {
					const timings = ['xph', 'Blade', 'Twig'].map((engine) => ({
						engine,
						time: median(fixture[stage][engine.toLowerCase()]),
					}));
					const fastest = timings.reduce((best, timing) =>
						timing.time < best.time ? timing : best,
					);
					const savings = timings
						.filter((timing) => timing !== fastest)
						.map(
							(timing) =>
								`${(timing.time === 0 ? 0 : (1 - fastest.time / timing.time) * 100).toFixed(2)}% vs ${timing.engine}`,
						)
						.join('; ');
					return `| ${[fixture.name, ...timings.map((timing) => timing.time.toFixed(2)), fastest.engine, savings].join(' | ')} |`;
				}),
			].join('\n'),
		)
		.join('\n\n');
	console.log(tables);
	const output = resolve(process.env.BENCH_OUTPUT ?? join(root, 'results.json'));
	const environment = results.environment;
	const readme = `# xph vs Blade vs Twig

Median microseconds per operation; lower is better. Percentages show the fastest engine’s reduction in time relative to each other engine.

${tables}

${environment.cpu} · PHP ${environment.php} · Node ${environment.node} · Blade ${environment.blade} · Twig ${environment.twig}.

[Raw results](<${relative(root, output).split('\\').join('/')}>)

Compilation includes xph's TypeScript checks; rendering uses warm caches and OPcache with debug instrumentation disabled.

[Cold startup, project builds, component/slot rendering, and runtime lookup comparisons](PROJECT.md) (run with \`pnpm bench:project\`).
`;
	const formatting = { useTabs: true, printWidth: 100 };
	await writeFile(output, await format(JSON.stringify(results), { ...formatting, parser: 'json' }));
	if (!process.env.BENCH_OUTPUT)
		await writeFile(
			join(root, 'README.md'),
			await format(readme, { ...formatting, parser: 'markdown' }),
		);
} finally {
	await rm(directory, { recursive: true, force: true });
}
