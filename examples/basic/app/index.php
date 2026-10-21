<?php
require __DIR__ . '/dist/xph.php';
$renderer = \Xph\renderer(['Page']);
$title = 'Hello from xph';
?>
<!doctype html>
<html lang="en">

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?php echo \Xph\escape($title); ?></title>
  <?php echo $renderer->styles(); ?>
</head>

<body>
  <?php echo $renderer->render('Page', ['title' => $title, 'items' => ['Typed props', 'Native PHP', 'Scoped CSS']]); ?>
  <?php echo $renderer->scripts(); ?>
</body>

</html>
