<?php

declare(strict_types=1);

// Use literal lists just like runtime.php: OPcache can optimize these itself.
$cases = [
    'boolean-attributes' => [
        ['allowfullscreen', 'selected', 'title', 'class', 'disabled', 'hidden'],
        static fn ($key) => in_array($key, ['allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled', 'formnovalidate', 'hidden', 'inert', 'ismap', 'itemscope', 'loop', 'multiple', 'muted', 'nomodule', 'novalidate', 'open', 'playsinline', 'readonly', 'required', 'reversed', 'selected'], true),
        static function ($key) {
            static $set = ['allowfullscreen'=>true, 'async'=>true, 'autofocus'=>true, 'autoplay'=>true, 'checked'=>true, 'controls'=>true, 'default'=>true, 'defer'=>true, 'disabled'=>true, 'formnovalidate'=>true, 'hidden'=>true, 'inert'=>true, 'ismap'=>true, 'itemscope'=>true, 'loop'=>true, 'multiple'=>true, 'muted'=>true, 'nomodule'=>true, 'novalidate'=>true, 'open'=>true, 'playsinline'=>true, 'readonly'=>true, 'required'=>true, 'reversed'=>true, 'selected'=>true];
            return isset($set[$key]);
        },
    ],
    'url-attributes' => [
        ['href', 'xlink:href', 'title', 'class', 'src', 'data-missing'],
        static fn ($key) => in_array($key, ['href', 'src', 'action', 'formaction', 'poster', 'data', 'background', 'cite', 'longdesc', 'manifest', 'codebase', 'profile', 'xlink:href'], true),
        static function ($key) {
            static $set = ['href'=>true, 'src'=>true, 'action'=>true, 'formaction'=>true, 'poster'=>true, 'data'=>true, 'background'=>true, 'cite'=>true, 'longdesc'=>true, 'manifest'=>true, 'codebase'=>true, 'profile'=>true, 'xlink:href'=>true];
            return isset($set[$key]);
        },
    ],
    'url-lists' => [
        ['srcset', 'archive', 'title', 'class', 'imagesrcset', 'ping'],
        static fn ($key) => in_array($key, ['srcset', 'imagesrcset', 'ping', 'archive'], true),
        static function ($key) {
            static $set = ['srcset'=>true, 'imagesrcset'=>true, 'ping'=>true, 'archive'=>true];
            return isset($set[$key]);
        },
    ],
    'unsafe-tags' => [
        ['script', 'noframes', 'div', 'my-card', 'iframe', 'span'],
        static fn ($key) => in_array($key, ['script', 'style', 'base', 'meta', 'object', 'embed', 'iframe', 'xmp', 'plaintext', 'noscript', 'noembed', 'noframes'], true),
        static function ($key) {
            static $set = ['script'=>true, 'style'=>true, 'base'=>true, 'meta'=>true, 'object'=>true, 'embed'=>true, 'iframe'=>true, 'xmp'=>true, 'plaintext'=>true, 'noscript'=>true, 'noembed'=>true, 'noframes'=>true];
            return isset($set[$key]);
        },
    ],
    'unsafe-schemes' => [
        ['javascript', 'data', 'https', 'mailto', 'vbscript', 'http'],
        static fn ($key) => in_array($key, ['javascript', 'vbscript', 'data'], true),
        static function ($key) {
            static $set = ['javascript'=>true, 'vbscript'=>true, 'data'=>true];
            return isset($set[$key]);
        },
    ],
    'asset-types' => [
        ['css', 'js', 'other', 'CSS'],
        static fn ($key) => in_array($key, ['css', 'js'], true),
        static function ($key) {
            static $set = ['css'=>true, 'js'=>true];
            return isset($set[$key]);
        },
    ],
];
$samples = (int) ($argv[1] ?? 7);
$iterations = 200000;
$results = [];
foreach ($cases as $name => [$keys, $array, $hash]) {
    foreach ($keys as $key) if ($array($key) !== $hash($key)) throw new RuntimeException('Lookup mismatch');
    $count = count($keys);
    for ($sample = 0; $sample < $samples; $sample++) {
        $operations = $sample % 2 ? ['isset' => $hash, 'in_array' => $array] : ['in_array' => $array, 'isset' => $hash];
        foreach ($operations as $kind => $operation) {
            $hits = 0;
            $start = hrtime(true);
            for ($i = 0; $i < $iterations; $i++) $hits += (int) $operation($keys[$i % $count]);
            $results[$name][$kind][] = (hrtime(true) - $start) / $iterations / 1000;
            if ($hits === 0) throw new RuntimeException('Expected lookup hits');
        }
    }
}
echo json_encode($results, JSON_THROW_ON_ERROR);
