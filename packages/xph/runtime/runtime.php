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
function configure(string $directory, bool $diagnostics = false): void {
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
  enableRuntimeDiagnostics($diagnostics);
  $GLOBALS['xph_manifest'] = $data;
  $GLOBALS['xph_directory'] = $directory;
  $GLOBALS['xph_closures'] = [];
  $GLOBALS['xph_assets'] = [];
}

/** Enable private source-location metadata explicitly; disabled until requested. */
function enableRuntimeDiagnostics(bool $enabled = true): void {
  $GLOBALS['xph_diagnostics'] = $enabled;
  if (!$enabled) unset($GLOBALS['xph_runtime_errors']);
}

function runtimeDiagnosticsEnabled(): bool {
  return $GLOBALS['xph_diagnostics'] ?? false;
}

/** Exception metadata is opt-in: never print paths, source, messages or traces to the response. */
function runtimeDiagnostics(\Throwable $error): array {
  if (!runtimeDiagnosticsEnabled()) return [];
  $frames = [];
  do {
    foreach (runtimeErrors()[$error] ?? [] as $frame) $frames[] = $frame;
    $error = $error->getPrevious();
  } while ($error !== null);
  return $frames;
}

/** Developer-facing logging helper. Call explicitly; never send its output to untrusted clients. */
function formatRuntimeError(\Throwable $error): string {
  $text = get_class($error) . ': ' . $error->getMessage();
  foreach (runtimeDiagnostics($error) as $frame) {
    $text .= "\nComponent: " . $frame['component'];
    if (isset($frame['location']['line'], $frame['location']['column'])) {
      $text .= "\nLocation: " . $frame['location']['line'] . ':' . $frame['location']['column'];
    }
    if (isset($frame['origin'])) {
      $text .= "\nPHP origin: " . $frame['origin']['line'] . ':' . $frame['origin']['column'];
    }
  }
  return $text;
}

/** @internal Weak keys do not retain exceptions between requests in long-running workers. */
function runtimeErrors(): \WeakMap {
  return $GLOBALS['xph_runtime_errors'] ??= new \WeakMap();
}

/** @internal Attach context without replacing the original throwable or its causal chain. */
function recordRuntimeError(\Throwable $error, string $component, array $location, ?array $origin = null): void {
  if (!runtimeDiagnosticsEnabled()) return;
  $errors = runtimeErrors();
  $frames = $errors[$error] ?? [];
  $expand = static fn(array $range): array => count($range) === 4 ? [
    'start' => $range[0],
    'end' => $range[1],
    'line' => $range[2],
    'column' => $range[3]
  ] : [];
  $frame = ['component' => $component, 'location' => $expand($location)];
  if ($origin !== null) $frame['origin'] = $expand($origin);
  $frames[] = $frame;
  $errors[$error] = $frames;
}

function escape(mixed $value): string {
  if ($value === null || $value === Undefined::value() || is_bool($value)) return '';
  if (is_int($value) || is_float($value)) $value = numberText((float) $value);
  if (!is_scalar($value)) throw new \InvalidArgumentException('Only scalar values can be escaped');
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

/** Validate a URL before HTML encoding; encoding is not URL validation. */
function safeUrl(string $value, string $name, string $tag): void {
  // The URL parser removes ASCII tabs/newlines and trims leading/trailing C0 controls.
  $url = trim(str_replace(["\t", "\r", "\n"], '', $value), "\x00..\x20");
  if (!preg_match('/^([a-z][a-z0-9+.-]*):/i', $url, $match)) return;
  $scheme = strtolower($match[1]);
  if (
    $scheme === 'data' && $tag === 'img' && $name === 'src' &&
    preg_match('~^data:image/(?:png|jpeg|gif|webp|avif|bmp|x-icon);base64,[a-z0-9+/=\s]*$~iD', $url)
  ) return;
  if (in_array($scheme, ['javascript', 'vbscript', 'data'], true)) {
    throw new \InvalidArgumentException('Unsafe URL scheme in ' . $name);
  }
}

function attribute(string $name, mixed $value, string $tag = ''): string {
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
  $lower = strtolower($name);
  if (!preg_match('/^[a-zA-Z_][\w:.-]*$/D', $name) || str_starts_with($lower, 'on') || $lower === 'srcdoc') {
    throw new \InvalidArgumentException('Unsupported HTML attribute: ' . $name);
  }
  if ($value === null || $value === Undefined::value()) return '';
  if (!is_scalar($value)) throw new \InvalidArgumentException('HTML attributes require scalar values');
  $tag = strtolower($tag);
  if (in_array($lower, ['href', 'src', 'action', 'formaction', 'poster', 'data', 'background', 'cite', 'longdesc', 'manifest', 'codebase', 'profile', 'xlink:href'], true)) {
    safeUrl((string) $value, $lower, $tag);
  } elseif (in_array($lower, ['srcset', 'imagesrcset', 'ping', 'archive'], true)) {
    // List attributes cannot use data URLs (commas are also candidate separators).
    foreach (preg_split('/[\s,]+/', (string) $value, -1, PREG_SPLIT_NO_EMPTY) as $url) safeUrl($url, $lower, $tag);
  }
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
function render(string $component, array $props = [], callable|array|null $slot = null): string {
  $entry = $GLOBALS['xph_manifest'][$component] ?? null;
  if ($entry === null) throw new \InvalidArgumentException('Unknown xph component: ' . $component);
  $closure = $GLOBALS['xph_closures'][$component] ??= require $GLOBALS['xph_directory'] . '/' . $entry['file'];
  return $closure($props, $slot);
}

/** An independent, non-consuming collection of dependency assets. */
final class AssetCollection {
  private array $records = [];
  private array $urls = [];

  public function prepare(string ...$components): void {
    $records = $this->records;
    $urls = $this->urls;
    foreach ($components as $component) {
      foreach (assets($component) as $asset) {
        if (isset($urls[$asset['url']])) continue;
        $urls[$asset['url']] = true;
        $records[] = $asset;
      }
    }
    $this->records = $records;
    $this->urls = $urls;
  }

  /** @return list<array{type: string, url: string}> */
  public function all(): array {
    return $this->records;
  }
}

final class Renderer {
  private AssetCollection $assets;
  private array $emitted = [];
  private bool $stylesClosed = false;

  public function __construct(array $components = []) {
    $this->assets = new AssetCollection();
    $this->prepare(...$components);
  }

  public function prepare(string ...$components): void {
    $next = clone $this->assets;
    $next->prepare(...$components);
    if ($this->stylesClosed) {
      foreach ($next->all() as $asset) {
        if ($asset['type'] === 'css' && !isset($this->emitted[$asset['url']])) {
          throw new \LogicException('Cannot prepare new CSS after styles() has been called. Prepare components before emitting styles.');
        }
      }
    }
    $this->assets = $next;
  }

  public function render(string $component, array $props = [], callable|array|null $slot = null): string {
    $this->prepare($component);
    return render($component, $props, $slot);
  }

  public function styles(): string {
    $tags = $this->tags('css');
    $this->stylesClosed = true;
    return $tags;
  }

  public function scripts(): string {
    return $this->tags('js');
  }

  private function tags(string $type): string {
    $tags = '';
    $emitted = $this->emitted;
    foreach ($this->assets->all() as $asset) {
      if ($asset['type'] !== $type || isset($emitted[$asset['url']])) continue;
      $url = attribute($type === 'css' ? 'href' : 'src', $asset['url'], $type === 'css' ? 'link' : 'script');
      $tags .= $type === 'css' ? '<link rel="stylesheet"' . $url . '>' : '<script type="module"' . $url . '></script>';
      $emitted[$asset['url']] = true;
    }
    $this->emitted = $emitted;
    return $tags;
  }
}

function renderer(array $components = []): Renderer {
  return new Renderer($components);
}

/** Render supplied slot content, forwarding positional values to callback slots. */
function renderSlot(callable|array|null $slots, string $name, array|Undefined $args = []): string {
  $slot = is_array($slots) && !is_callable($slots)
    ? ($slots[$name] ?? null)
    : ($name === 'default' ? $slots : null);
  return $slot === null ? '' : $slot(...($args instanceof Undefined ? [] : array_values($args)));
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
  if (in_array(strtolower($value), ['script', 'style', 'base', 'meta', 'object', 'embed', 'iframe', 'xmp', 'plaintext', 'noscript', 'noembed', 'noframes'], true)) {
    throw new \InvalidArgumentException('Unsafe dynamic element name.');
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

function attributes(array $props, string $tag = ''): string {
  $out = '';
  foreach ($props as $name => $value) {
    if (!is_string($name) || !preg_match('/^[a-zA-Z_][\w.-]*$/D', $name) || preg_match('/^on/i', $name) || $name === 'slot') {
      throw new \InvalidArgumentException('Unsupported spread attribute');
    }
    if (!is_scalar($value) && $value !== null && $value !== Undefined::value()) {
      throw new \InvalidArgumentException('Spread attributes require scalar values');
    }
    $out .= attribute($name, $value, $tag);
  }
  return $out;
}
