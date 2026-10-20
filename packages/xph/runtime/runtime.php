<?php
declare(strict_types=1);
namespace Xph;

/** Identity-based sentinel for JavaScript undefined, distinct from every user value. */
final class Undefined {
    private static ?self $instance = null;
    private function __construct() {}
    private function __clone() {}
    public static function value(): self {
        return self::$instance ??= new self();
    }
}
/** @var array<string, array{file: string, assets: list<array{type: string, url: string}>, dependencies: list<string>}> */
$manifest = [];
/** Load a build's manifest. Multiple builds can be loaded independently by calling configure. */
function configure(string $directory): void {
    $data = json_decode(file_get_contents($directory . '/manifest.json'), true, 512, JSON_THROW_ON_ERROR);
    $GLOBALS['xph_manifest'] = $data;
    $GLOBALS['xph_directory'] = $directory;
    $GLOBALS['xph_closures'] = [];
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
function raw(mixed $value): string { return $value === null || $value === Undefined::value() ? '' : (string) $value; }
function attribute(string $name, mixed $value): string {
    static $boolean = ['allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled', 'formnovalidate', 'hidden', 'inert', 'ismap', 'itemscope', 'loop', 'multiple', 'muted', 'nomodule', 'novalidate', 'open', 'playsinline', 'readonly', 'required', 'reversed', 'selected'];
    if ($value === null || $value === Undefined::value()) return '';
    if (str_starts_with($name, 'aria-') || str_starts_with($name, 'data-')) {
        if (is_bool($value)) $value = $value ? 'true' : 'false';
    } elseif (in_array(strtolower($name), $boolean, true)) {
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
function length(mixed $value): mixed { return $value === null || $value === Undefined::value() ? Undefined::value() : count($value); }
function divide(int|float $a, int|float $b): float { return fdiv((float) $a, (float) $b); }
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
