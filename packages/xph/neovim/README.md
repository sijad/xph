# xph for Neovim

Requires Neovim 0.11+, Node.js 22+, and the built xph CLI. The plugin provides `.xph` file detection, Astro-style highlighting with embedded PHP, and a client for `xph lsp`. It uses Neovim's built-in LSP and syntax runtime; no `nvim-lspconfig`, Astro plugin, or PHP language server is required.

## Install

From this workspace, run `pnpm build`. Add this to your `init.lua`, replacing both paths:

```lua
vim.opt.runtimepath:prepend('/absolute/path/to/xph/packages/xph/neovim')

require('xph').setup({
  cmd = { 'node', '/absolute/path/to/xph/packages/xph/dist/cli.js', 'lsp' },
})

vim.cmd('syntax enable')
```

For an npm installation, the runtime is included at `node_modules/xph/neovim`. If `xph` is already on PATH, use `require('xph').setup()` without a `cmd` override. Configure the runtime path before calling `setup()`.

Restart Neovim and open a `.xph` file. The client starts in the nearest directory containing `xph.config.ts`, falling back to the nearest `package.json` or `.git`, then the file's directory. Each project gets its own server, and the CLI loads that project's PHP configuration. Calling `setup()` also attaches to existing xph buffers.

## Editing

Diagnostics appear through `vim.diagnostic`. Hover, TypeScript contract completion, and Go to Definition use the same server as VS Code. Component tags/imports navigate to component files; contract properties, constants, and TypeScript references navigate to their source declarations.

Use `K` for hover and `<C-x><C-o>` in Insert mode for LSP completion. For a buffer-local definition mapping and automatic completion, pass an `on_attach` callback:

```lua
require('xph').setup({
  -- Set cmd here if xph is not on PATH.
  on_attach = function(client, bufnr)
    vim.keymap.set('n', 'gd', vim.lsp.buf.definition, { buffer = bufnr })
    vim.lsp.completion.enable(true, client.id, bufnr, { autotrigger = true })
  end,
})
```

Call `setup()` once with your combined options. It accepts Neovim LSP client options such as `cmd`, `capabilities`, and `on_attach`. Existing completion plugins can supply their capabilities through the same options. See [Neovim's LSP documentation](https://neovim.io/doc/user/lsp/).

Syntax highlighting reuses Neovim's Astro, TypeScript, HTML, CSS, and PHP syntax files. Server PHP blocks do not need `<?php` tags. PHP strings and comments can contain `</script>` without ending the highlighting region. Highlighting works before the language server starts.

## Tree-sitter highlighting

Neovim already supports Astro through `nvim-treesitter`. xph reuses that parser and its highlight queries, with separate xph injection rules to parse `<script server lang="php">` bodies using `php_only`. Ordinary `.astro` buffers keep their existing queries. Frontmatter, expressions, and browser scripts use TypeScript; styles use CSS.

Install the `astro`, `php_only`, `typescript`, and `css` parsers and their queries using your existing `nvim-treesitter` installation. On its current branch:

```lua
require('nvim-treesitter').install({ 'astro', 'php_only', 'typescript', 'css' })
```

Or use `:TSInstall astro php_only typescript css`. After installation finishes, enable highlighting in your existing setup call and reopen the buffer:

```lua
require('xph').setup({
  treesitter = true,
  -- Include your cmd and on_attach options here as needed.
})
```

The injection queries adapt [nvim-treesitter’s Astro queries](https://github.com/nvim-treesitter/nvim-treesitter/tree/main/runtime/queries/astro); their license is included in `queries/xph/nvim-treesitter-LICENSE.txt`.

No xph parser needs to be installed. The plugin loads the installed Astro binary under a separate query namespace, so PHP is not also injected as TypeScript. If the required parsers or highlight queries are unavailable, it keeps Vim syntax highlighting. Tree-sitter is opt-in; omit the option or set `treesitter = false` for Vim syntax.

The Astro parser uses HTML script boundaries: a literal `</script>` inside a PHP string or comment can terminate its script node early. Use Vim syntax for components containing those literals; its PHP rules handle them. Fixing this in Tree-sitter would require changing the upstream parser.

PHP diagnostics require PHP 8.2+; configure its executable with `php` in `xph.config.ts`. PHP symbol completion and navigation are not provided by the current language server.

Inspect clients with `:checkhealth vim.lsp` and diagnostics with `:lua vim.diagnostic.open_float()`. If attachment fails, verify the CLI path and run `xph lsp` from your project directory.

## Validation

`pnpm build && pnpm exec vitest run tests/neovim.test.ts` runs a headless Neovim check against the real CLI, covering file detection, highlighting, project configuration, diagnostics, completion, hover, and definition ranges. The test is skipped when Neovim is unavailable. A second test checks real Tree-sitter PHP captures, injection boundaries, Astro query isolation, and fallback behavior when the parsers and queries are installed at Neovim’s default `data/site` directory. Set `XPH_NVIM_TS_RUNTIME` to test a different installation directory.
