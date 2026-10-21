<?php

namespace Xph\Laravel\Tests;

use Illuminate\Support\Facades\Blade;
use Illuminate\Support\Facades\Route;
use Illuminate\Filesystem\Filesystem;
use Orchestra\Testbench\TestCase;
use Xph\Laravel\Renderer;
use Xph\Laravel\XphServiceProvider;

class IntegrationTest extends TestCase {
  private string $build;

  protected function getPackageProviders($app): array {
    return [XphServiceProvider::class];
  }

  protected function setUp(): void {
    parent::setUp();
    $this->build = sys_get_temp_dir() . '/xph-laravel-' . bin2hex(random_bytes(8));
    mkdir($this->build);
    copy(__DIR__ . '/../../xph/runtime/runtime.php', $this->build . '/runtime.php');
    file_put_contents($this->build . '/component.php', <<<'PHP'
<?php
return static function (array $props, ?callable $slot = null): string {
    return '<h1>'.\Xph\escape($props['title'] ?? 'Hello').'</h1>';
};
PHP);
    file_put_contents($this->build . '/manifest.json', json_encode([
      'resources/component' => [
        'file' => 'component.php',
        'dependencies' => ['resources/dependency'],
        'assets' => [
          ['type' => 'css', 'url' => '/xph/shared.css'],
          ['type' => 'js', 'url' => '/xph/component.js?a=1&b=2'],
        ],
      ],
      'resources/dependency' => [
        'file' => 'component.php',
        'dependencies' => [],
        'assets' => [
          ['type' => 'css', 'url' => '/xph/dependency.css'],
          ['type' => 'css', 'url' => '/xph/shared.css'],
        ],
      ],
      'resources/other' => [
        'file' => 'component.php',
        'dependencies' => [],
        'assets' => [['type' => 'css', 'url' => '/xph/other.css']],
      ],
    ]));
    $this->app['config']->set('xph.build_path', $this->build);
  }

  protected function tearDown(): void {
    (new Filesystem)->deleteDirectory($this->build);
    parent::tearDown();
  }

  public function test_blade_injects_dependency_assets_once_and_resets_between_requests(): void {
    Route::get('/page', fn() => response(Blade::render(<<<'BLADE'
<html><head><title>Page</title></head><body>
@xph('resources/component', ['title' => $title])
@xph('resources/component')
</body></html>
BLADE, ['title' => '<Hello>'])));
    for ($i = 0; $i < 2; $i++) {
      $html = $this->get('/page')->assertOk()->getContent();
      $this->assertSame(1, substr_count($html, 'shared.css'));
      $this->assertSame(1, substr_count($html, 'component.js'));
      $this->assertStringContainsString('<h1>&lt;Hello&gt;</h1>', $html);
      $this->assertLessThan(strpos($html, '</head>'), strpos($html, 'shared.css'));
      $this->assertGreaterThan(strpos($html, '<h1>'), strpos($html, 'component.js'));
      $this->assertStringContainsString('a=1&amp;b=2', $html);
    }
  }

  public function test_streamed_html_emits_assets_before_component_once(): void {
    Route::get('/stream', fn() => response()->stream(function () {
      echo '<html><head></head><body>';
      echo Blade::render("@xph('resources/component') @xph('resources/component')");
      echo '</body></html>';
    }, 200, ['Content-Type' => 'text/html']));
    $html = $this->get('/stream')->assertOk()->streamedContent();
    $this->assertSame(1, substr_count($html, 'shared.css'));
    $this->assertSame(1, substr_count($html, 'component.js'));
    $this->assertLessThan(strpos($html, '<h1>'), strpos($html, 'shared.css'));
  }

  public function test_json_and_event_streams_are_untouched(): void {
    Route::get('/json', fn() => response()->json([
      'html' => Blade::render("@xph('resources/component')"),
    ]));
    $this->get('/json')->assertExactJson(['html' => '<h1>Hello</h1>']);
    Route::get('/events', fn() => response()->stream(function () {
      echo "data: hello\n\n";
    }, 200, ['Content-Type' => 'text/event-stream']));
    $this->assertSame("data: hello\n\n", $this->get('/events')->streamedContent());
  }

  public function test_fragments_receive_assets_and_stale_headers_are_removed(): void {
    Route::get('/fragment', fn() => response(Blade::render("@xph('resources/component')"))
      ->header('Content-Length', '14')->header('ETag', 'old'));
    $response = $this->get('/fragment')->assertOk()->assertHeaderMissing('ETag')
      ->assertHeaderMissing('Content-Length');
    $this->assertStringStartsWith('<link ', $response->getContent());
    $this->assertStringEndsWith('</script>', $response->getContent());
  }

  public function test_unknown_component_has_a_clear_error(): void {
    $this->expectException(\InvalidArgumentException::class);
    $this->expectExceptionMessage('Unknown xph component: missing');
    $this->app->make(Renderer::class)->render('missing');
  }

  public function test_real_blade_layout_and_include_collect_assets_in_dependency_order(): void {
    mkdir($this->build . '/views');
    file_put_contents(
      $this->build . '/views/layout.blade.php',
      '<!doctype html><html><HEAD><title>@yield("title")</title></HEAD><body>@yield("content")</body></html>'
    );
    file_put_contents($this->build . '/views/page.blade.php', <<<'BLADE'
@extends('layout')
@section('title', 'Component page')
@section('content')
    @include('greeting', ['heading' => $title])
    @xph('resources/other')
    @include('greeting', ['heading' => 'Again'])
@endsection
BLADE);
    file_put_contents(
      $this->build . '/views/greeting.blade.php',
      "@xph('resources/component', ['title' => \$heading])"
    );
    $this->app['view']->addLocation($this->build . '/views');
    Route::get('/layout', fn() => view('page', ['title' => '<Welcome>']));

    // Render twice to exercise compiled Blade caching as well as the initial compile.
    for ($i = 0; $i < 2; $i++) {
      $html = $this->get('/layout')->assertOk()->getContent();
      $this->assertStringContainsString('<title>Component page</title>', $html);
      $this->assertStringContainsString('<h1>&lt;Welcome&gt;</h1>', $html);
      $this->assertSame(3, substr_count($html, '<h1>'));
      foreach (['dependency.css', 'shared.css', 'other.css', 'component.js'] as $asset) {
        $this->assertSame(1, substr_count($html, $asset), $asset);
      }
      $this->assertLessThan(strpos($html, 'shared.css'), strpos($html, 'dependency.css'));
      $this->assertLessThan(strpos($html, '</HEAD>'), strpos($html, 'other.css'));
      $this->assertLessThan(strpos($html, '</body>'), strpos($html, 'component.js'));
    }
  }

  public function test_assets_do_not_leak_into_different_pages_in_the_same_worker(): void {
    Route::get('/first', fn() => response(Blade::render("@xph('resources/component')")));
    Route::get('/second', fn() => response(Blade::render("@xph('resources/other')")));
    Route::get('/plain', fn() => response('<html><head></head><body>Plain</body></html>'));

    $this->get('/first')->assertSee('component.js', false);
    $this->get('/second')->assertSee('other.css', false)
      ->assertDontSee('shared.css', false)->assertDontSee('component.js', false);
    $this->get('/plain')->assertContent('<html><head></head><body>Plain</body></html>');
    $this->get('/first')->assertSee('component.js', false)->assertDontSee('other.css', false);
  }

  public function test_stream_collects_new_assets_across_separate_renders_and_resets_afterward(): void {
    Route::get('/chunks', fn() => response()->stream(function () {
      echo '<html><head></head><body>';
      echo Blade::render("@xph('resources/component')");
      echo '<hr>';
      echo Blade::render("@xph('resources/other')");
      echo Blade::render("@xph('resources/component')");
      echo '</body></html>';
    }, 200, ['Content-Type' => 'text/html; charset=UTF-8']));

    for ($i = 0; $i < 2; $i++) {
      $html = $this->get('/chunks')->assertOk()->streamedContent();
      $this->assertSame(3, substr_count($html, '<h1>Hello</h1>'));
      foreach (['dependency.css', 'shared.css', 'other.css', 'component.js'] as $asset) {
        $this->assertSame(1, substr_count($html, $asset), $asset);
      }
      $this->assertLessThan(strpos($html, '<h1>'), strpos($html, 'component.js'));
      $this->assertGreaterThan(strpos($html, '<hr>'), strpos($html, 'other.css'));
      $this->assertFalse($this->app->make(Renderer::class)->streaming);
    }
  }

  public function test_missing_build_only_fails_when_a_component_is_rendered(): void {
    $this->app['config']->set('xph.build_path', $this->build . '/missing');
    Route::get('/no-components', fn() => response('No components'));
    $this->get('/no-components')->assertOk()->assertContent('No components');

    $this->expectException(\RuntimeException::class);
    $this->expectExceptionMessage('Run xph build first.');
    $this->app->make(Renderer::class)->render('resources/component');
  }

  public function test_encoded_html_is_not_modified(): void {
    Route::get('/encoded', function () {
      $html = Blade::render("@xph('resources/component')");
      return response(gzencode($html))->header('Content-Type', 'text/html')
        ->header('Content-Encoding', 'gzip');
    });
    $response = $this->get('/encoded')->assertOk()->assertHeader('Content-Encoding', 'gzip');
    $this->assertSame('<h1>Hello</h1>', gzdecode($response->getContent()));
  }

  public function test_downloads_are_not_modified_even_with_html_content_type(): void {
    file_put_contents($this->build . '/download.html', '<p>Download</p>');
    Route::get('/download', function () {
      Blade::render("@xph('resources/component')");
      return response()->download($this->build . '/download.html', 'page.html', [
        'Content-Type' => 'text/html',
      ]);
    });
    $this->get('/download')->assertOk()->assertDownload('page.html');
    $this->assertSame('<p>Download</p>', file_get_contents($this->build . '/download.html'));
  }

  public function test_stream_failure_cleans_up_renderer_state(): void {
    Route::get('/broken-stream', fn() => response()->stream(function () {
      echo Blade::render("@xph('resources/component')");
      throw new \RuntimeException('Interrupted stream');
    }, 200, ['Content-Type' => 'text/html']));
    $response = $this->get('/broken-stream')->assertOk();
    $level = ob_get_level();
    ob_start();
    try {
      $response->baseResponse->sendContent();
      $this->fail('Expected the stream exception to propagate.');
    } catch (\RuntimeException $exception) {
      $this->assertSame('Interrupted stream', $exception->getMessage());
    } finally {
      while (ob_get_level() > $level) ob_end_clean();
    }
    $this->assertFalse($this->app->make(Renderer::class)->streaming);

    Route::get('/after-error', fn() => response(Blade::render("@xph('resources/component')")));
    $html = $this->get('/after-error')->assertOk()->getContent();
    $this->assertSame(1, substr_count($html, 'shared.css'));
    $this->assertSame(1, substr_count($html, 'component.js'));
  }

  public function test_unmodified_html_keeps_existing_cache_headers(): void {
    Route::get('/static', fn() => response('<p>Plain</p>')
      ->header('Content-Length', '12')->header('ETag', '"unchanged"'));
    $this->get('/static')->assertOk()->assertContent('<p>Plain</p>')
      ->assertHeader('Content-Length', '12')->assertHeader('ETag', '"unchanged"');
  }

  public function test_composer_discovery_registers_the_tested_provider(): void {
    $composer = json_decode(file_get_contents(__DIR__ . '/../composer.json'), true, 512, JSON_THROW_ON_ERROR);
    $this->assertSame([XphServiceProvider::class], $composer['extra']['laravel']['providers']);
    $this->assertTrue($this->app->bound(Renderer::class));
    $this->assertArrayHasKey('xph', $this->app['blade.compiler']->getCustomDirectives());
  }
}
