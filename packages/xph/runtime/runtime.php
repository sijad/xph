<?php

declare(strict_types=1);

namespace Xph;

/** Identity-based sentinel for JavaScript undefined, distinct from every user value. */
final class Undefined {
  private static ?self $instance = null;
  private function __construct() {
  }
  private function __clone() {
  }
  public static function value(): self {
    return self::$instance ??= new self();
  }
}

/** Activate a build, replacing the current manifest and clearing its caches. */
function configure(string $directory): void {
  $path = $directory . '/manifest.json';
  $contents = @file_get_contents($path);
  if ($contents === false) throw new \RuntimeException('Unable to read xph manifest: ' . $path);
  try {
    $manifest = json_decode($contents, false, 512, JSON_THROW_ON_ERROR);
  } catch (\JsonException $error) {
    throw new \RuntimeException('Invalid xph manifest JSON: ' . $path, 0, $error);
  }
  if (!$manifest instanceof \stdClass) throw new \RuntimeException('Invalid xph manifest structure: ' . $path);
  $data = [];
  foreach ($manifest as $id => $entry) {
    if (
      !$entry instanceof \stdClass || !isset($entry->file) || !is_string($entry->file) ||
      !isset($entry->assets, $entry->dependencies) || !is_array($entry->assets) || !is_array($entry->dependencies)
    ) {
      throw new \RuntimeException('Invalid xph manifest entry: ' . $path . ' (' . $id . ')');
    }
    $assets = [];
    foreach ($entry->assets as $asset) {
      if (
        !$asset instanceof \stdClass || !isset($asset->type, $asset->url) ||
        !in_array($asset->type, ['css', 'js'], true) || !is_string($asset->url)
      ) {
        throw new \RuntimeException('Invalid xph manifest asset: ' . $path . ' (' . $id . ')');
      }
      $assets[] = ['type' => $asset->type, 'url' => $asset->url];
    }
    foreach ($entry->dependencies as $dependency) {
      if (!is_string($dependency)) throw new \RuntimeException('Invalid xph manifest dependency: ' . $path . ' (' . $id . ')');
    }
    $data[$id] = ['file' => $entry->file, 'assets' => $assets, 'dependencies' => $entry->dependencies];
  }
  foreach ($data as $id => $entry) {
    foreach ($entry['dependencies'] as $dependency) {
      if (!isset($data[$dependency])) throw new \RuntimeException('Unknown xph manifest dependency: ' . $path . ' (' . $id . ': ' . $dependency . ')');
    }
  }
  $GLOBALS['xph_manifest'] = $data;
  $GLOBALS['xph_directory'] = $directory;
  $GLOBALS['xph_closures'] = [];
  $GLOBALS['xph_assets'] = [];
}

function escape(mixed $value): string {
  if ($value === null || $value === Undefined::value() || is_bool($value)) return '';
  if (is_int($value) || is_float($value)) $value = numberText((float) $value);
  return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** JavaScript scalar number formatting using PHP's shortest round-trip JSON representation. */
function numberText(float $value): string {
  if (is_nan($value)) return 'NaN';
  if (is_infinite($value)) return $value < 0 ? '-Infinity' : 'Infinity';
  if ($value == 0) return '0';
  $precision = ini_get('serialize_precision');
  try {
    ini_set('serialize_precision', '-1');
    $text = strtolower(json_encode($value, JSON_THROW_ON_ERROR));
  } finally {
    ini_set('serialize_precision', $precision);
  }
  if (!str_contains($text, 'e')) return $text;
  [$mantissa, $power] = explode('e', $text);
  $exponent = (int) $power;
  $negative = str_starts_with($mantissa, '-');
  $mantissa = ltrim($mantissa, '-');
  if (abs($value) >= 1e-6 && abs($value) < 1e21) {
    $point = strpos($mantissa, '.');
    if ($point === false) $point = strlen($mantissa);
    $digits = str_replace('.', '', $mantissa);
    $at = $point + $exponent;
    if ($at <= 0) $text = '0.' . str_repeat('0', -$at) . $digits;
    elseif ($at >= strlen($digits)) $text = $digits . str_repeat('0', $at - strlen($digits));
    else $text = substr($digits, 0, $at) . '.' . substr($digits, $at);
    if (str_contains($text, '.')) $text = rtrim(rtrim($text, '0'), '.');
    return ($negative ? '-' : '') . $text;
  }
  $mantissa = preg_replace('/\.0$/', '', $mantissa);
  return ($negative ? '-' : '') . $mantissa . 'e' . ($exponent >= 0 ? '+' : '') . $exponent;
}

function raw(mixed $value): string {
  return $value === null || $value === Undefined::value() ? '' : (string) $value;
}

function attribute(string $name, mixed $value): string {
  static $boolean = [
    'allowfullscreen' => true,
    'async' => true,
    'autofocus' => true,
    'autoplay' => true,
    'checked' => true,
    'controls' => true,
    'default' => true,
    'defer' => true,
    'disabled' => true,
    'formnovalidate' => true,
    'hidden' => true,
    'inert' => true,
    'ismap' => true,
    'itemscope' => true,
    'loop' => true,
    'multiple' => true,
    'muted' => true,
    'nomodule' => true,
    'novalidate' => true,
    'open' => true,
    'playsinline' => true,
    'readonly' => true,
    'required' => true,
    'reversed' => true,
    'selected' => true
  ];
  if ($value === null || $value === Undefined::value()) return '';
  $lower = strtolower($name);
  if (str_starts_with($lower, 'aria-') || str_starts_with($lower, 'data-')) {
    if (is_bool($value)) $value = $value ? 'true' : 'false';
  } elseif (isset($boolean[$lower])) {
    return $value === false ? '' : ' ' . $name;
  } elseif ($value === false) return '';
  if ($value === true) $value = 'true';
  return ' ' . $name . '="' . escape($value) . '"';
}

function get(mixed $base, string|int|float $key, bool $optional = false): mixed {
  if ($base === null || $base === Undefined::value()) {
    if ($optional) return Undefined::value();
    throw new \InvalidArgumentException('Property access on a nullish value');
  }
  if (is_float($key) && (!is_finite($key) || floor($key) !== $key)) return Undefined::value();
  if (is_float($key)) $key = (int) $key;
  return array_key_exists($key, $base) ? $base[$key] : Undefined::value();
}

function nullish(mixed $value, callable $fallback): mixed {
  return $value === null || $value === Undefined::value() ? $fallback() : $value;
}

function length(mixed $value): mixed {
  return $value === null || $value === Undefined::value() ? Undefined::value() : count($value);
}

function divide(int|float $a, int|float $b): float {
  return fdiv((float) $a, (float) $b);
}

function strictEqual(mixed $a, mixed $b): bool {
  if ((is_int($a) || is_float($a)) && (is_int($b) || is_float($b))) return (float) $a === (float) $b;
  return $a === $b;
}

/** @param array<string,mixed> $props */
function render(string $component, array $props = [], ?callable $slot = null): string {
  $entry = $GLOBALS['xph_manifest'][$component] ?? null;
  if ($entry === null) throw new \InvalidArgumentException('Unknown xph component: ' . $component);
  $closure = $GLOBALS['xph_closures'][$component] ??= require $GLOBALS['xph_directory'] . '/' . $entry['file'];
  return $closure($props, $slot);
}

/** @return list<array{type: string, url: string}> */
function assets(string $component): array {
  if (isset($GLOBALS['xph_assets'][$component])) return $GLOBALS['xph_assets'][$component];
  $seen = [];
  $urls = [];
  $result = [];
  $visit = function (string $id) use (&$visit, &$seen, &$urls, &$result): void {
    if (isset($seen[$id])) return;
    $seen[$id] = true;
    $entry = $GLOBALS['xph_manifest'][$id] ?? throw new \InvalidArgumentException('Unknown xph component: ' . $id);
    foreach ($entry['dependencies'] as $dependency) $visit($dependency);
    foreach ($entry['assets'] as $asset) if (!isset($urls[$asset['url']])) {
      $urls[$asset['url']] = true;
      $result[] = $asset;
    }
  };
  $visit($component);
  return $GLOBALS['xph_assets'][$component] = $result;
}

function elementName(mixed $value): string {
  if (!is_string($value) || !preg_match('/^[a-zA-Z][a-zA-Z0-9:._-]*$/D', $value)) {
    throw new \InvalidArgumentException('Invalid dynamic element name.');
  }
  return $value;
}

/** Merge attribute groups in source order, with the last value winning. */
function mergeProps(array ...$groups): array {
  return array_replace([], ...$groups);
}

/** JavaScript truthiness, including truthy "0" strings and empty objects/arrays. */
function classTruthy(mixed $value): bool {
  if ($value === null || $value === Undefined::value() || $value === false) return false;
  if (is_string($value)) return $value !== '';
  if (is_int($value) || is_float($value)) return $value != 0 && !is_nan((float) $value);
  return true;
}

/** Flatten class values using clsx semantics. */
function classList(mixed $value, bool $object = false): string {
  if (!classTruthy($value) || is_bool($value)) return '';
  if (is_string($value)) return $value;
  if (is_int($value) || is_float($value)) return numberText((float) $value);
  if (!is_array($value)) return '';
  $classes = [];
  $list = !$object && ($value === [] || array_keys($value) === range(0, count($value) - 1));
  foreach ($value as $key => $item) {
    $text = $list ? classList($item) : (classTruthy($item) ? (string) $key : '');
    if ($text !== '') $classes[] = $text;
  }
  return implode(' ', $classes);
}

/** Merge ordinary props normally and combine class with the class:list directive. */
function classProps(array ...$groups): array {
  $props = mergeProps(...$groups);
  $classes = classList([$props['class'] ?? null, $props['class:list'] ?? null]);
  unset($props['class:list']);
  $props['class'] = $classes === '' ? null : $classes;
  return $props;
}

function attributes(array $props): string {
  $out = '';
  foreach ($props as $name => $value) {
    if (!is_string($name) || !preg_match('/^[a-zA-Z_][\w.-]*$/D', $name) || preg_match('/^on/i', $name) || $name === 'slot') {
      throw new \InvalidArgumentException('Unsupported spread attribute');
    }
    if (!is_scalar($value) && $value !== null && $value !== Undefined::value()) {
      throw new \InvalidArgumentException('Spread attributes require scalar values');
    }
    $out .= attribute($name, $value);
  }
  return $out;
}
