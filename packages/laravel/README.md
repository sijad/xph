# xph for Laravel

Composer package `sijad/xph` for Laravel 13 and PHP 8.3+. Render compiled xph components
from Blade with automatic CSS and JavaScript loading.

Run the application setup commands below from your Laravel application's root directory.
Development requires Node.js 22.12+ and Composer. Production needs PHP and the generated
build files; Node.js is only required when building components.

## Install

This package lives in the xph monorepo and is not yet published to Packagist. For local
development, add a Composer path repository pointing to this directory:

```sh
composer config repositories.xph path /absolute/path/to/xph/packages/laravel
composer require sijad/xph:@dev
npm install --save-dev xph
```

Laravel discovers the service provider automatically. Optionally publish configuration:

```sh
php artisan vendor:publish --tag=xph-config
```

## Create a component

Create `resources/component.xph`:

```astro
---
export interface Props {
    title: string;
}
---

<section class="greeting">
    <h1>{props.title}</h1>
    <button type="button" data-greeting>Say hello</button>
</section>

<style>
    .greeting { padding: 1rem; color: navy; }
</style>

<script>
    document.querySelectorAll('[data-greeting]').forEach((button) => {
        button.addEventListener('click', () => alert('Hello from xph!'));
    });
</script>
```

The compiler generates PHP for the markup, scoped CSS, and a JavaScript module.

## Build

Create `xph.config.ts` in the Laravel application root:

```ts
export default {
	entries: ['resources/component.xph'],
	outDir: 'storage/framework/xph',
	assetBase: '/xph/',
};
```

Build and publish assets after each build, including during deployment:

```sh
npx xph build
php artisan vendor:publish --tag=xph-assets --force
```

Imports are compiled automatically. Add each independently rendered component to `entries`.
Keep the generated PHP and manifest in storage; only asset files are published to `public/xph`.
The default asset publication path is `public/xph`; keep it aligned with `assetBase`.
Changing `outDir` also requires changing `build_path` in `config/xph.php`.

## Blade

Create `resources/views/welcome.blade.php`:

```blade
<!doctype html>
<html>
<head>
    <title>My page</title>
</head>
<body>
    @xph('resources/component', ['title' => $title])
</body>
</html>
```

Return the view from `routes/web.php`, passing the component's title:

```php
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return view('welcome', ['title' => 'Hello from Laravel']);
});
```

Start Laravel with `php artisan serve` and open the URL printed by Artisan. The page
renders the component, loads its stylesheet, and runs its button script automatically.

The component ID is its path relative to the xph project root, without `.xph`.
Props are passed as a PHP array; map Eloquent models to the arrays/scalars expected by
the component contract. No head directive is needed. Component HTML is output directly;
the xph runtime escapes dynamic text and attributes.

Middleware automatically adds dependency CSS before `</head>` and module scripts before
`</body>`, deduplicated per request. For fragments without those closing tags, CSS is
prepended and scripts appended. Render complete HTML through the normal Laravel response
flow so middleware can collect assets before sending it. JSON, downloads, encoded responses,
and event streams are left untouched. HTML response caches must store the injected result.

## Development and deployment

After editing a component, run the build and asset publication commands again:

```sh
npx xph build
php artisan vendor:publish --tag=xph-assets --force
```

`npx xph dev` watches components and rebuilds the output in storage, but does not copy
updated assets to `public/xph`; run the publication command after rebuilds.

During deployment, build and publish before serving the new release. Include both
`storage/framework/xph` and `public/xph` in the deployed application. Keep the manifest,
compiled components, runtime, and public assets from the same build together.

## Streamed HTML

For `response()->stream(...)`, explicitly set `Content-Type: text/html` and render the
Blade components inside the stream callback. Asset tags are emitted before the first
component using them, since an already sent head cannot be modified. Late stylesheet
loading can cause layout shifts. Streaming the output of `view(...)->render()` still
buffers that individual Blade view before emitting it.

```php
Route::get('/stream', function () {
    return response()->stream(function () {
        echo '<!doctype html><html><head><title>Page</title></head><body>';
        echo view('partials.greeting', ['title' => 'Hello from Laravel'])->render();
        echo '</body></html>';
    }, 200, ['Content-Type' => 'text/html']);
});
```

Here, `resources/views/partials/greeting.blade.php` contains:

```blade
@xph('resources/component', ['title' => $title])
```

## Troubleshooting

- **Missing xph build:** run `npx xph build` and check that the compiler's `outDir`
  matches Laravel's `xph.build_path` configuration.
- **Unknown xph component:** use the project-relative path without `.xph`, add the
  component to `entries` if it is not already imported, and rebuild.
- **CSS or JavaScript returns 404:** publish assets again and check that `assetBase`
  is `/xph/` when using the default `public/xph` destination.
- **Blade prints an old directive or configuration:** run `php artisan view:clear`
  or `php artisan config:clear` after changing the corresponding cached setup.

## Tests

From this package's directory in the xph repository:

```sh
composer install
composer test
```

The integration suite uses Laravel 13 via Orchestra Testbench and the compiler's real PHP runtime.
It covers Blade layouts and includes, compiled view reuse, dependency asset ordering,
request isolation, streamed HTML and failure cleanup, cache headers, missing builds,
and responses that must remain untouched (JSON, event streams, encoded HTML, and downloads).

From the repository root, also run the compiler-to-adapter test:

```sh
pnpm exec vitest run tests/laravel.test.ts
```
