# xph for VS Code

Language support for `.xph` components: Astro-style syntax highlighting, diagnostics, TypeScript contract completion/hover, and component navigation.

Frontmatter, markup, expressions, browser scripts, and styles use Astro highlighting. `<script is:server>` blocks use PHP highlighting without requiring `<?php` tags. The Astro extension is not required.

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

Node.js must be available on the extension host's PATH. For native PHP diagnostics, install PHP 8.0+ and configure its executable in `xph.config.ts`.

Startup errors appear in **View → Output → xph**.

PHP completion, hover, go-to-definition and semantic diagnostics inside server blocks can use an optional PHP language server such as Intelephense. Install the backend separately and configure it in `xph.config.ts`:

```ts
export default {
	srcDir: 'src',
	phpLanguageServer: {
		command: 'intelephense',
		args: ['--stdio'],
	},
};
```

Restart the xph extension host after configuration changes. Installing the Intelephense VS Code extension alone does not enable this bridge; the configured command must be available on the extension host's PATH. The bridge maps PHP results to `.xph` and preserves completion snippets and edits within server blocks. Rename, signature help and completion resolution are not supported yet.

At startup, the extension automatically finds the nearest `xph.config.ts` above the active or open `.xph` file, stopping at the workspace folder. If no parent config exists, it uses the sole config found inside that workspace folder. No VS Code config-path setting is needed. For workspaces containing multiple projects, open a `.xph` file in the desired project before reloading the window.

The xph Output panel shows the selected configuration and PHP backend launch errors. An absolute backend command, such as a Mason executable path, works even when Mason's bin directory is absent from VS Code's PATH. Rebuild and reinstall the VSIX after changing the extension source.

PHP code actions are available from the lightbulb or **Quick Fix…** inside a server block. Backend-provided Fix All actions also support VS Code's `editor.codeActionsOnSave` with `"source.fixAll": "explicit"`. Available fixes depend on the PHP server and its enabled features. The bridge supports edit-based actions and resolves deferred edits; all edits must stay within the current component's PHP blocks. Actions requiring backend commands, generated-wrapper edits, or changes to other files are omitted.

Use **Format Document** to format the full component. Prettier with the Astro plugin formats frontmatter, markup, expressions, browser scripts and styles; the configured PHP backend formats server blocks. The language server loads your project's own Prettier and Astro plugin versions. These are optional dependencies: install them in the project to enable Astro formatting:

```sh
pnpm add -D prettier prettier-plugin-astro
```

Prettier 3+ is required. If either package is absent, the rest of the component is preserved and PHP formatting still runs. Neither the Astro nor Prettier VS Code extension is required. To format on save:

```json
{
	"[xph]": {
		"editor.defaultFormatter": "xph.xph-vscode",
		"editor.formatOnSave": true
	}
}
```

Formatting uses project Prettier settings (including EditorConfig), with the editor's tab size and spaces setting as defaults. Each PHP block is formatted independently to preserve its scope and keep PHP out of Astro's JavaScript parser. Without a PHP backend, PHP contents are preserved while the rest of the component is formatted. PHP formatting is separate from code actions and does not require `source.fixAll` on save.
