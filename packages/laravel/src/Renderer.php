<?php

namespace Xph\Laravel;

use RuntimeException;

class Renderer {
  private bool $loaded = false;
  private array $assets = [];
  private array $emitted = [];
  public bool $streaming = false;

  public function __construct(private readonly string $directory, private readonly bool $diagnostics = false) {
  }

  public function reset(): void {
    $this->loaded = false;
    $this->assets = $this->emitted = [];
    $this->streaming = false;
  }

  public function render(string $component, array $props = []): string {
    if (!$this->loaded) {
      if (!is_file($this->directory . '/runtime.php') || !is_file($this->directory . '/manifest.json')) {
        throw new RuntimeException('Missing xph build in ' . $this->directory . '. Run xph build first.');
      }
      if (!function_exists('Xph\\configure')) {
        require_once $this->directory . '/runtime.php';
      }
      \Xph\configure($this->directory, $this->diagnostics);
      $this->loaded = true;
    }
    foreach (\Xph\assets($component) as $asset) {
      $this->assets[$asset['url']] = $asset;
    }
    $html = \Xph\render($component, $props);
    return $this->streaming ? $this->tags() . $html : $html;
  }

  private function tags(?string $type = null): string {
    $html = '';
    foreach ($this->assets as $url => $asset) {
      if (isset($this->emitted[$url]) || ($type !== null && $asset['type'] !== $type)) continue;
      $this->emitted[$url] = true;
      $escaped = htmlspecialchars($url, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
      $html .= $asset['type'] === 'css'
        ? '<link rel="stylesheet" href="' . $escaped . '">'
        : '<script type="module" src="' . $escaped . '"></script>';
    }
    return $html;
  }

  public function inject(string $html): string {
    $css = $this->tags('css');
    $js = $this->tags('js');
    $head = strripos($html, '</head>');
    $html = $head === false ? $css . $html : substr_replace($html, $css, $head, 0);
    $body = strripos($html, '</body>');
    return $body === false ? $html . $js : substr_replace($html, $js, $body, 0);
  }
}
