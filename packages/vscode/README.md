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

PHP formatting, completion, hover, go-to-definition and semantic diagnostics inside server blocks use an optional PHP language server. If the PHP Intelephense VS Code extension is installed, xph automatically uses its bundled server and your `intelephense` settings. No separate global installation is needed. xph starts its own stdio process for virtual PHP documents; it does not attach to the other extension’s running client.

For another backend or an explicit executable, configure `phpLanguageServer` in `xph.config.ts`. Project configuration takes precedence over automatic detection:

```ts
export default {
	srcDir: 'src',
	phpLanguageServer: {
		command: 'intelephense',
		args: ['--stdio'],
	},
};
```

Restart the xph extension host after configuration changes or installing Intelephense. Set `xph.php.autoDetect` to `false` to disable automatic discovery. For an explicit backend, the configured command must be available on the extension host's PATH (or use an absolute path). The bridge maps PHP results to `.xph` and preserves completion snippets and edits within server blocks. Rename, signature help and completion resolution are not supported yet.

At startup, the extension automatically finds the nearest `xph.config.ts` above the active or open `.xph` file, stopping at the workspace folder. If no parent config exists, it uses the sole config found inside that workspace folder. No VS Code config-path setting is needed. For workspaces containing multiple projects, open a `.xph` file in the desired project before reloading the window.

The xph Output panel shows the selected configuration, discovery of the installed Intelephense server, and PHP backend launch errors. An absolute backend command, such as a Mason executable path, works even when Mason's bin directory is absent from VS Code's PATH. Rebuild and reinstall the VSIX after changing the extension source.

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

Formatting uses project Prettier settings (including EditorConfig), with the editor's tab size and spaces setting as defaults. Each PHP block is formatted independently to preserve its scope and keep PHP out of Astro's JavaScript parser. The Astro formatting pass preserves each PHP block exactly, including whitespace and line endings. Without a PHP backend, PHP contents remain unchanged while the rest of the component is formatted. PHP formatting is separate from code actions and does not require `source.fixAll` on save.
