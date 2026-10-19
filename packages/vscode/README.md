# xph for VS Code

Language support for `.xph` components: Astro-style syntax highlighting, diagnostics, TypeScript contract completion/hover, and component navigation.

Frontmatter, markup, expressions, browser scripts, and styles use Astro highlighting. `<script server lang="php">` blocks use PHP highlighting without requiring `<?php` tags. The Astro extension is not required.

Build a local VSIX from the workspace root:

```sh
pnpm package:vscode
```

In VS Code, run **Extensions: Install from VSIX…** and select `packages/vscode/xph-vscode-0.1.0.vsix`. Reload VS Code after installing.

The extension launches `xph lsp`. Set `xph.executable` to your local CLI when xph is not on PATH:

```json
{
	"xph.executable": "/absolute/path/to/xph/packages/xph/dist/cli.js"
}
```

Node.js must be available on the extension host's PATH. For native PHP diagnostics, install PHP 8.2+ and configure its executable in `xph.config.ts`.

Startup errors appear in **View → Output → xph**.
