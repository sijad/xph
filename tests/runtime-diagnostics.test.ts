import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, compile, position } from '../packages/xph/src/index.js';

async function failure(source: string, expression: string, inline = false) {
	const result = await compile(source, { filename: '/private/app/UserCard.xph' });
	expect(result.diagnostics).toEqual([]);
	// Runtime metadata does not depend on a deployed source file or a JS-side mapping object.
	result.mappings = [];
	const directory = await mkdtemp(join(tmpdir(), 'xph-errors-'));
	try {
		const file = join(directory, 'component.php');
		const php = inline
			? `<?php\n\n\n\n$render = (static function () {\n${result.php.replace(/^<\?php\s*declare\(strict_types=1\);\s*/, '')}})();`
			: result.php;
		await writeFile(file, php);
		const output = execFileSync(
			'php',
			[
				'-r',
				`
require ${JSON.stringify(resolve('packages/xph/runtime/runtime.php'))};
\\Xph\\enableRuntimeDiagnostics();
${inline ? `require ${JSON.stringify(file)};` : `$render = require ${JSON.stringify(file)};`}
ob_start();
try { $render(['userId' => 1]); } catch (Throwable $error) {
  $response = ob_get_clean();
  echo json_encode([
    'class' => get_class($error), 'message' => $error->getMessage(), 'code' => $error->getCode(),
    'same' => !isset($GLOBALS['original']) || $error === $GLOBALS['original'],
    'trace' => $error->getTrace(),
    'sameTrace' => !isset($GLOBALS['trace']) || $error->getTrace() === $GLOBALS['trace'],
    'previous' => $error->getPrevious()?->getMessage(),
    'diagnostics' => \\Xph\\runtimeDiagnostics($error),
    'formatted' => \\Xph\\formatRuntimeError($error), 'response' => $response,
  ]);
}`,
			],
			{ encoding: 'utf8' },
		);
		const error = JSON.parse(output);
		const start = source.indexOf(expression);
		const at = position(source, start);
		expect(error.diagnostics[0]).toMatchObject({
			component: 'UserCard.xph',
			location: {
				start,
				end: start + expression.length,
				line: at.line + 1,
				column: at.character + 1,
			},
		});
		expect(error.same).toBe(true);
		expect(error.sameTrace).toBe(true);
		expect(error.trace.length).toBeGreaterThan(0);
		expect(error.response).toBe('');
		expect(error.formatted).not.toContain('/private/app');
		return error;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

const server = `---
export interface Props { userId: number }
export interface Server { name(id: number): string }
---
<script is:server>
return ['name' => static function (float $id): string {
  if ($id === 0.0) return 'ok';
  $GLOBALS['original'] = new RuntimeException('Database unavailable', 17, new LogicException('cause'));
  $GLOBALS['trace'] = $GLOBALS['original']->getTrace();
  throw $GLOBALS['original'];
}];
</script>
`;

it('locates separate calls on the same line and preserves the original throwable and cause', async () => {
	const source = server + '<p>{server.name(0)} {server.name(props.userId)}</p>';
	const error = await failure(source, 'server.name(props.userId)');
	expect(error).toMatchObject({
		class: 'RuntimeException',
		message: 'Database unavailable',
		previous: 'cause',
		code: 17,
	});
	expect(error.diagnostics[0].origin.line).toBe(8);
	expect(error.formatted).toContain('Location: 13:22');
});

it.each([false, true])(
	'maps multiline calls and PHP origins with inline output: %s',
	async (inline) => {
		const expression = 'server.name(\n  props.userId\n)';
		const error = await failure(server + `<p>{${expression}}</p>`, expression, inline);
		expect(error.diagnostics[0].origin.line).toBe(8);
	},
);

it('locates server initialization failures without a template expression', async () => {
	const code = "\nthrow new Error('initialization');\n";
	const error = await failure(`<script is:server>${code}</script>`, code);
	expect(error.class).toBe('Error');
	expect(error.diagnostics[0].origin).toMatchObject({ line: 2, column: 1 });
});

it('locates expression evaluation errors outside server code', async () => {
	const source =
		'---\nexport interface Props { user: { name: string } }\n---\n<p>{props.user.name}</p>';
	const error = await failure(source, 'props.user.name');
	expect(error.class).toBe('InvalidArgumentException');
});

it.each([
	'<p title={server.name(props.userId)} />',
	'{true ? <p title={server.name(props.userId)} /> : null}',
])('locates attribute expressions: %s', async (template) => {
	await failure(server + template, 'server.name(props.userId)');
});

it('locates repeated calls within a single expression', async () => {
	const expression = 'server.name(0) + server.name(props.userId)';
	await failure(server + `<p>{${expression}}</p>`, expression);
});

it.each([false, true])(
	'retains nested component locations with parent-owned slot: %s',
	async (slot) => {
		const directory = await mkdtemp(join(tmpdir(), 'xph-nested-errors-'));
		try {
			await mkdir(join(directory, 'src'));
			await writeFile(
				join(directory, 'src/Child.xph'),
				slot ? '<section><slot /></section>' : server + '<p>{server.name(props.userId)}</p>',
			);
			await writeFile(
				join(directory, 'src/Page.xph'),
				server.replace('---\n', "---\nimport Child from './Child.xph';\n") +
					(slot
						? '<Child><p>{server.name(props.userId)}</p></Child>'
						: '<Child userId={props.userId} />'),
			);
			const built = await build({ root: directory, srcDir: 'src' });
			expect(built.diagnostics).toEqual([]);
			const output = execFileSync(
				'php',
				[
					'-r',
					`
require ${JSON.stringify(join(built.outDir, 'xph.php'))};
\\Xph\\enableRuntimeDiagnostics();
for ($i = 0; $i < 2; $i++) {
  try { \\Xph\\render('Page', ['userId' => 1]); }
  catch (Throwable $error) { $results[] = \\Xph\\runtimeDiagnostics($error); }
}
echo json_encode($results);`,
				],
				{ encoding: 'utf8' },
			);
			const results = JSON.parse(output);
			expect(results[0]).toEqual(results[1]);
			expect(results[0].map((frame: { component: string }) => frame.component)).toEqual(
				slot ? ['Page.xph', 'Child.xph', 'Page.xph'] : ['Child.xph', 'Page.xph'],
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

it('supports missing metadata without changing exceptions or printing diagnostics', () => {
	const output = execFileSync(
		'php',
		[
			'-r',
			`
require ${JSON.stringify(resolve('packages/xph/runtime/runtime.php'))};
$error = new RuntimeException('legacy');
echo json_encode([\\Xph\\runtimeDiagnostics($error), \\Xph\\formatRuntimeError($error)]);`,
		],
		{ encoding: 'utf8' },
	);
	expect(JSON.parse(output)).toEqual([[], 'RuntimeException: legacy']);
});

it('does not collect source details by default and respects explicit enable/disable', async () => {
	const result = await compile('<script is:server>throw new RuntimeException("private");</script>');
	const directory = await mkdtemp(join(tmpdir(), 'xph-private-errors-'));
	try {
		const file = join(directory, 'component.php');
		await writeFile(file, result.php);
		const output = execFileSync(
			'php',
			[
				'-r',
				`
require ${JSON.stringify(resolve('packages/xph/runtime/runtime.php'))};
$render = require ${JSON.stringify(file)};
$states = [];
foreach ([null, true, false] as $enabled) {
  if ($enabled !== null) \\Xph\\enableRuntimeDiagnostics($enabled);
  try { $render([]); } catch (Throwable $error) {
    $states[] = [\\Xph\\runtimeDiagnosticsEnabled(), count(\\Xph\\runtimeDiagnostics($error))];
    if ($enabled === null) $unmapped = $error;
    if ($enabled === true) {
      $mapped = $error;
      $wrapped = new RuntimeException('framework wrapper', 0, $error);
      $wrapperFrames = \\Xph\\runtimeDiagnostics($wrapped);
    }
  }
}
\\Xph\\enableRuntimeDiagnostics();
echo json_encode([$states, count(\\Xph\\runtimeDiagnostics($unmapped)), count($wrapperFrames), count(\\Xph\\runtimeDiagnostics($mapped))]);`,
			],
			{ encoding: 'utf8' },
		);
		expect(JSON.parse(output)).toEqual([
			[
				[false, 0],
				[true, 1],
				[false, 0],
			],
			0,
			1,
			0,
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
