# xph website

Static package website, deployed to https://xph.js.org/ by
`.github/workflows/pages.yml`. The build adds syntax highlighting at build time;
the published site needs no JavaScript runtime for highlighting.
All local asset URLs are relative so the site supports both `/xph/` and `/`.

## Preview

From the repository root, run:

```sh
pnpm preview:website
```

This builds the highlighted site and serves it at http://localhost:8000/.
Use `pnpm preview:website --port 8080` to choose another port. Press Ctrl+C to
stop; restart the command after editing the website source.

To build without starting a server, run `pnpm build:website`. Pages runs the
same build automatically and deploys `website/dist/`.

## Code examples

Edit examples as escaped plain text in `website/index.html`, inside
`<pre><code data-language="xph">…</code></pre>`. Supported languages include
`xph`, `typescript`, `javascript`, `php`, `css`, `json`, `shellscript`, and `html`.
Use `data-theme="dark"` on a code block for a dark background.

Examples keep their exact text and whitespace; formatting is manual. Shiki uses
the VS Code extension's xph grammar, including embedded PHP, TypeScript, and CSS.
The build writes highlighted HTML and copies static assets to `website/dist/`
without changing source files. No Prettier step or browser highlighter is used.
