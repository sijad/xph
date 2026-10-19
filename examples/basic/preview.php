<?php
require __DIR__ . '/dist/xph.php';
$html = \Xph\render('src/Page', ['title' => 'Hello from xph', 'items' => ['Typed props', 'Native PHP', 'Scoped CSS']]);
$tags = '';
foreach (\Xph\assets('src/Page') as $asset) {
    $url = \Xph\escape($asset['url']);
    $tags .= $asset['type'] === 'css' ? '<link rel="stylesheet" href="' . $url . '">' : '<script type="module" src="' . $url . '"></script>';
}
echo str_replace('</head>', $tags . '</head>', $html);
