<?php

namespace Xph\Laravel;

use Illuminate\Contracts\Http\Kernel;
use Illuminate\Support\Facades\Blade;
use Illuminate\Support\ServiceProvider;

class XphServiceProvider extends ServiceProvider {
  public function register(): void {
    $this->mergeConfigFrom(__DIR__ . '/../config/xph.php', 'xph');
    $this->app->scoped(Renderer::class, fn($app) => new Renderer(
      $app['config']->get('xph.build_path'),
    ));
  }

  public function boot(): void {
    Blade::directive(
      'xph',
      fn($expression) =>
      '<?php echo app(\\Xph\\Laravel\\Renderer::class)->render(' . $expression . '); ?>'
    );
    $this->app->afterResolving(
      Kernel::class,
      fn($kernel) =>
      $kernel->pushMiddleware(InjectAssets::class)
    );
    $this->publishes([
      __DIR__ . '/../config/xph.php' => config_path('xph.php'),
    ], 'xph-config');
    // Run vendor:publish --tag=xph-assets after each xph build.
    $this->publishes([
      $this->app['config']->get('xph.build_path') . '/assets' => public_path('xph'),
    ], 'xph-assets');
  }
}
