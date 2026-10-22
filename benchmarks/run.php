<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';
require __DIR__ . '/../packages/xph/runtime/runtime.php';

use Illuminate\Container\Container;
use Illuminate\Events\Dispatcher;
use Illuminate\Filesystem\Filesystem;
use Illuminate\View\Compilers\BladeCompiler;
use Illuminate\View\Engines\CompilerEngine;
use Illuminate\View\Engines\EngineResolver;
use Illuminate\View\Factory;
use Illuminate\View\FileViewFinder;
use Twig\Environment;
use Twig\Loader\FilesystemLoader;
use Twig\Source;

[$script, $directory, $iterations, $samples, $renders] = $argv;
$files = new Filesystem();
$compiler = new BladeCompiler($files, $directory . '/cache');
$files->makeDirectory($directory . '/cache');
$resolver = new EngineResolver();
$resolver->register('blade', fn() => new CompilerEngine($compiler, $files));
$container = new Container();
$factory = new Factory($resolver, new FileViewFinder($files, [$directory]), new Dispatcher($container));
$factory->setContainer($container);
$factory->share('__env', $factory);
$twig = new Environment(new FilesystemLoader($directory), [
  'cache' => $directory . '/twig-cache',
  'auto_reload' => false,
  'autoescape' => 'html',
]);
\Xph\configure($directory, false);
$fixtures = json_decode(file_get_contents($directory . '/fixtures.json'), true, 512, JSON_THROW_ON_ERROR);

function measure(callable $operation, int $count): float {
  $start = hrtime(true);
  for ($i = 0; $i < $count; $i++) $operation();
  return (hrtime(true) - $start) / $count / 1000;
}

$results = [];
foreach ($fixtures as $fixture) {
  $name = $fixture['name'];
  $data = $fixture['data'];
  $renderers = [
    'xph' => fn() => \Xph\render($name, $data),
    'blade' => fn() => $factory->make($name, $data)->render(),
    'twig' => fn() => $twig->render($name . '.html.twig', $data),
  ];
  $expected = trim($renderers['blade']());
  // xph may preserve one newline after its frontmatter; ignore only outer whitespace.
  foreach ($renderers as $engine => $render) {
    $actual = trim($render());
    if ($expected !== $actual) {
      throw new RuntimeException('Output mismatch: ' . $name . ' (' . $engine . ')' . "\nBlade: " . $expected . "\nActual: " . $actual);
    }
  }
  $twigSource = new Source($fixture['twig'], $name . '.html.twig');
  $compilers = [
    'blade' => fn() => $compiler->compileString($fixture['blade']),
    'twig' => fn() => $twig->compileSource($twigSource),
  ];
  for ($i = 0; $i < 10; $i++) {
    foreach ($compilers as $operation) $operation();
    foreach ($renderers as $operation) $operation();
  }
  $row = ['bytes' => strlen($expected), 'compile' => ['blade' => [], 'twig' => []], 'render' => ['xph' => [], 'blade' => [], 'twig' => []]];
  for ($sample = 0; $sample < (int) $samples; $sample++) {
    // Rotate engines between batches to reduce systematic ordering bias.
    foreach (['compile' => $compilers, 'render' => $renderers] as $stage => $operations) {
      $engines = array_keys($operations);
      $offset = $sample % count($engines);
      $order = array_merge(array_slice($engines, $offset), array_slice($engines, 0, $offset));
      foreach ($order as $engine) {
        $row[$stage][$engine][] = measure($operations[$engine], (int) ($stage === 'compile' ? $iterations : $renders));
      }
    }
  }
  $results[$name] = $row;
}
echo json_encode([
  'environment' => [
    'php' => PHP_VERSION,
    'blade' => \Composer\InstalledVersions::getPrettyVersion('illuminate/view'),
    'twig' => \Composer\InstalledVersions::getPrettyVersion('twig/twig'),
    'os' => PHP_OS_FAMILY,
    'opcache.enable_cli' => ini_get('opcache.enable_cli'),
    'opcache.active' => function_exists('opcache_get_status') && opcache_get_status(false) !== false,
    'opcache.file_update_protection' => ini_get('opcache.file_update_protection'),
    'jit' => ini_get('opcache.jit'),
  ],
  'results' => $results,
], JSON_THROW_ON_ERROR);
