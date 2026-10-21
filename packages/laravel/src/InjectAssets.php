<?php

namespace Xph\Laravel;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;

class InjectAssets {
  public function handle(Request $request, Closure $next): Response {
    $renderer = app(Renderer::class);
    $renderer->reset();
    $response = $next($request);
    $type = strtolower(explode(';', $response->headers->get('Content-Type', ''))[0]);
    if (
      $type !== 'text/html' || $response instanceof BinaryFileResponse
      || $response->headers->has('Content-Encoding')
    ) return $response;

    if ($response instanceof StreamedResponse) {
      $callback = $response->getCallback();
      if ($callback !== null) {
        $response->setCallback(function () use ($callback, $renderer): void {
          $renderer->streaming = true;
          try {
            $callback();
          } finally {
            $renderer->reset();
          }
        });
      }
      return $response;
    }
    $content = $response->getContent();
    if (is_string($content)) {
      $updated = $renderer->inject($content);
      if ($updated !== $content) {
        $response->setContent($updated);
        $response->headers->remove('Content-Length');
        $response->headers->remove('ETag');
      }
    }
    return $response;
  }
}
