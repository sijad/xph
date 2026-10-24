import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { attributeKind } from '../packages/xph/src/static-html.js';
import { compile } from '../packages/xph/src/compiler.js';

it('keeps specialized attributes equivalent to generic validation for scalars and hostile values', () => {
	const attributes = [
		'title',
		'CLASS',
		'hidden',
		'DISABLED',
		'ARIA-expanded',
		'data-ready',
		'href',
		'xlink:href',
		'src',
		'srcset',
		'ping',
	];
	const cases = attributes.flatMap((name) =>
		['a', 'img'].map((tag) => [name, attributeKind(name), tag]),
	);
	const encoded = Buffer.from(JSON.stringify(cases)).toString('base64');
	const values = Buffer.from(
		JSON.stringify([
			'',
			'0',
			'<&"\'',
			null,
			false,
			true,
			0,
			-1,
			1.25,
			1e21,
			'/safe?a=1&b=2',
			'javascript:alert(1)',
			'java\tscript:alert(1)',
			'data:image/png;base64,YQ==',
			'/one.png 1x, javascript:alert(1) 2x',
		]),
	).toString('base64');
	const output = execFileSync(
		'php',
		[
			'-r',
			`
require ${JSON.stringify(resolve('packages/xph/runtime/runtime.php'))};
set_error_handler(static function ($severity, $message) { throw new ErrorException($message, 0, $severity); });
$cases = json_decode(base64_decode('${encoded}'), true);
$values = array_merge(json_decode(base64_decode('${values}'), true), [INF, NAN, "\\xff", \\Xph\\Undefined::value(), [], new stdClass()]);
$serialize = static function ($operation) {
  try { return ['value' => $operation()]; }
  catch (Throwable $error) { return ['error' => get_class($error), 'message' => $error->getMessage()]; }
};
$mismatches = [];
foreach ($cases as [$name, $kind, $tag]) foreach ($values as $index => $value) {
  $generic = $serialize(static fn () => \\Xph\\attribute($name, $value, $tag));
  $special = $serialize(static fn () => \\Xph\\attributeValue($name, $value, $kind, $tag));
  if ($generic !== $special) $mismatches[] = [$name, $tag, $index, $generic, $special];
}
echo json_encode($mismatches, JSON_THROW_ON_ERROR);
`,
		],
		{ encoding: 'utf8' },
	);
	expect(JSON.parse(output)).toEqual([]);
});

it('specializes fixed names and keeps spread attributes on the validated path', async () => {
	const result = await compile(`---
interface Props { value: string; attrs: { title: string } }
---
<input title={props.value} disabled={props.value} aria-label={props.value} href={props.value} srcset={props.value}/><p {...props.attrs}/>`);
	expect(result.diagnostics).toEqual([]);
	for (const [name, kind] of [
		['title', 0],
		['disabled', 1],
		['aria-label', 2],
		['href', 3],
		['srcset', 4],
	])
		expect(result.php).toContain(
			`\\Xph\\attributeValue('${name}', \\Xph\\get($props, 'value', false), ${kind}, 'input')`,
		);
	expect(result.php).toContain('\\Xph\\attributes(');
});

it('preserves spread validation errors and attribute serialization', () => {
	const output = execFileSync(
		'php',
		[
			'-r',
			`
require ${JSON.stringify(resolve('packages/xph/runtime/runtime.php'))};
$values = ['<&', null, false, true, 0, 1.5, [], new stdClass(), \\Xph\\Undefined::value(), 'javascript:alert(1)', 'data:image/png;base64,YQ=='];
$mismatches = [];
foreach (['title', 'DISABLED', 'ARIA-label', 'data-ready', 'href', 'src', 'srcset', 'srcdoc', 'SRCDOC'] as $name) {
  foreach ($values as $index => $value) {
    foreach (['img', 'a'] as $tag) {
      $capture = static function ($callback) {
        try { return ['value' => $callback()]; }
        catch (InvalidArgumentException $error) { return ['error' => $error->getMessage()]; }
      };
      $expected = !is_scalar($value) && $value !== null && $value !== \\Xph\\Undefined::value()
        ? ['error' => 'Spread attributes require scalar values']
        : $capture(static fn() => \\Xph\\attribute($name, $value, $tag));
      $actual = $capture(static fn() => \\Xph\\attributes([$name => $value], $tag));
      if ($actual !== $expected) $mismatches[] = [$name, $index, $tag, $expected, $actual];
    }
  }
}
echo json_encode($mismatches, JSON_THROW_ON_ERROR);
`,
		],
		{ encoding: 'utf8' },
	);
	expect(JSON.parse(output)).toEqual([]);
});
