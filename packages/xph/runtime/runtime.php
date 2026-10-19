<?php
declare(strict_types=1);
namespace Xph;

/** @var array<string, array{file: string, assets: list<array{type: string, url: string}>, dependencies: list<string>}> */
enum Undefined { case Value; }
$manifest = [];
/** Load a build's manifest. Multiple builds can be loaded independently by calling configure. */
function configure(string $directory): void {
    $data = json_decode(file_get_contents($directory . '/manifest.json'), true, 512, JSON_THROW_ON_ERROR);
    $GLOBALS['xph_manifest'] = $data;
    $GLOBALS['xph_directory'] = $directory;
    $GLOBALS['xph_closures'] = [];
}
function escape(mixed $value): string {
    if ($value === null || $value === Undefined::Value || is_bool($value)) return '';
    if (is_int($value) || is_float($value)) $value = numberText((float) $value);
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}
/** JavaScript scalar number formatting using PHP's shortest round-trip JSON representation. */
function numberText(float $value): string {
    if (is_nan($value)) return 'NaN';
    if (is_infinite($value)) return $value < 0 ? '-Infinity' : 'Infinity';
    if ($value == 0) return '0';
    $text = strtolower(json_encode($value, JSON_THROW_ON_ERROR));
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
function raw(mixed $value): string { return $value === null || $value === Undefined::Value ? '' : (string) $value; }
function attribute(string $name, mixed $value): string {
    static $boolean = ['allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled', 'formnovalidate', 'hidden', 'inert', 'ismap', 'itemscope', 'loop', 'multiple', 'muted', 'nomodule', 'novalidate', 'open', 'playsinline', 'readonly', 'required', 'reversed', 'selected'];
    if ($value === null || $value === Undefined::Value) return '';
    if (str_starts_with($name, 'aria-') || str_starts_with($name, 'data-')) {
        if (is_bool($value)) $value = $value ? 'true' : 'false';
    } elseif (in_array(strtolower($name), $boolean, true)) {
        return $value === false ? '' : ' ' . $name;
    } elseif ($value === false) return '';
    if ($value === true) $value = 'true';
    return ' ' . $name . '="' . escape($value) . '"';
}
function get(mixed $base, string|int|float $key, bool $optional = false): mixed {
    if ($base === null || $base === Undefined::Value) {
        if ($optional) return Undefined::Value;
        throw new \InvalidArgumentException('Property access on a nullish value');
    }
    if (is_float($key) && (!is_finite($key) || floor($key) !== $key)) return Undefined::Value;
    if (is_float($key)) $key = (int) $key;
    return array_key_exists($key, $base) ? $base[$key] : Undefined::Value;
}
function nullish(mixed $value, callable $fallback): mixed {
    return $value === null || $value === Undefined::Value ? $fallback() : $value;
}
function length(mixed $value): mixed { return $value === null || $value === Undefined::Value ? Undefined::Value : count($value); }
function divide(int|float $a, int|float $b): float { return fdiv((float) $a, (float) $b); }
function strictEqual(mixed $a, mixed $b): bool {
    if ((is_int($a) || is_float($a)) && (is_int($b) || is_float($b))) return (float) $a === (float) $b;
    return $a === $b;
}
/** @param array<string,mixed> $schema */
function validate(mixed $value, array $schema, string $path): void {
    $valid = match ($schema['kind']) {
        'string' => is_string($value),
        'number' => (is_int($value) || is_float($value)) && is_finite((float) $value),
        'boolean' => is_bool($value),
        'null' => $value === null,
        'literal' => strictEqual($value, $schema['value']),
        'array' => is_array($value) && array_is_list($value),
        'object' => is_array($value) && ($value === [] || !array_is_list($value)),
        'union' => unionMatches($value, $schema['types'], $path),
        'function' => $value instanceof \Closure,
        default => false,
    };
    if (!$valid) throw new \InvalidArgumentException("Invalid {$path}: expected {$schema['kind']}");
    if ($schema['kind'] === 'array') foreach ($value as $key => $item) validate($item, $schema['element'], $path . '[' . $key . ']');
    if ($schema['kind'] === 'object') foreach ($schema['fields'] as $key => $field) {
        if (!array_key_exists($key, $value) || $value[$key] === Undefined::Value) {
            if (!$field['optional']) throw new \InvalidArgumentException("Missing {$path}.{$key}");
        } else validate($value[$key], $field['type'], $path . '.' . $key);
    }
}
/** @param array<string,mixed> $server @param array<string,mixed> $schema */
function serverMethods(array $server, array $schema): array {
    foreach ($schema['fields'] as $name => $field) {
        $method = $field['type'];
        if ($method['kind'] !== 'function') continue;
        $closure = $server[$name];
        $parameters = (new \ReflectionFunction($closure))->getParameters();
        $server[$name] = static function (mixed ...$arguments) use ($closure, $method, $name, $parameters): mixed {
            if (count($arguments) !== count($method['parameters'])) throw new \InvalidArgumentException("Invalid server.{$name}: wrong argument count");
            foreach ($method['parameters'] as $index => $parameter) {
                validate($arguments[$index], $parameter['type'], 'server.' . $name . '.' . $parameter['name']);
                $phpType = ($parameters[$index] ?? null)?->getType();
                // Template numbers are doubles; PHP int parameters require lossless conversion.
                if ($phpType instanceof \ReflectionNamedType && $phpType->getName() === 'int' && is_float($arguments[$index]) && (float) (int) $arguments[$index] === $arguments[$index]) $arguments[$index] = (int) $arguments[$index];
            }
            $result = $closure(...$arguments);
            validate($result, $method['returns'], 'server.' . $name . '.return');
            return $result;
        };
    }
    return $server;
}
/** @param list<array<string,mixed>> $schemas */
function unionMatches(mixed $value, array $schemas, string $path): bool {
    foreach ($schemas as $schema) {
        try { validate($value, $schema, $path); return true; } catch (\InvalidArgumentException) {}
    }
    return false;
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
    $seen = []; $urls = []; $result = [];
    $visit = function (string $id) use (&$visit, &$seen, &$urls, &$result): void {
        if (isset($seen[$id])) return;
        $seen[$id] = true;
        $entry = $GLOBALS['xph_manifest'][$id] ?? throw new \InvalidArgumentException('Unknown xph component: ' . $id);
        foreach ($entry['dependencies'] as $dependency) $visit($dependency);
        foreach ($entry['assets'] as $asset) if (!isset($urls[$asset['url']])) { $urls[$asset['url']] = true; $result[] = $asset; }
    };
    $visit($component);
    return $result;
}
