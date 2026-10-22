<?php

declare(strict_types=1);

[$script, $directory, $mode, $samples, $renders] = $argv;
require $directory . '/dist/xph.php';
$fixture = json_decode(file_get_contents($directory . '/fixture.json'), true, 512, JSON_THROW_ON_ERROR);
$data = $fixture['data'];
$expected = $fixture['expected'];
$render = static fn () => \Xph\render('Page', $data);
if ($render() !== $expected) throw new RuntimeException('Project output mismatch');
if (count(\Xph\assets('Page')) !== 1) throw new RuntimeException('Expected one stylesheet');
if ($mode === 'cold') {
    echo json_encode(['bytes' => strlen($expected), 'php' => PHP_VERSION]);
    exit;
}
$operations = [
    'components-and-slots' => $render,
    // Includes manifest parsing and first closure loads for a fresh request.
    'configure-and-render' => static function () use ($directory, $render) {
        \Xph\configure($directory . '/dist');
        return $render();
    },
    'renderer-and-assets' => static function () use ($data) {
        $renderer = \Xph\renderer(['Page']);
        return $renderer->styles() . $renderer->render('Page', $data) . $renderer->scripts();
    },
];
$results = [];
$renderer = \Xph\renderer(['Page']);
$styledExpected = $renderer->styles() . $expected . $renderer->scripts();
for ($sample = 0; $sample < (int) $samples; $sample++) {
    $names = array_keys($operations);
    $offset = $sample % count($names);
    foreach (array_merge(array_slice($names, $offset), array_slice($names, 0, $offset)) as $name) {
        $start = hrtime(true);
        for ($i = 0; $i < (int) $renders; $i++) $actual = $operations[$name]();
        $results[$name][] = (hrtime(true) - $start) / (int) $renders / 1000;
        if ($actual !== ($name === 'renderer-and-assets' ? $styledExpected : $expected)) throw new RuntimeException('Project output mismatch: ' . $name);
    }
}
echo json_encode(['php' => PHP_VERSION, 'bytes' => strlen($expected), 'results' => $results], JSON_THROW_ON_ERROR);
