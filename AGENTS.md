# Repository Guidelines

## Project Structure & Module Organization

This repository is a pnpm workspace for xph, which compiles typed Astro-like components to PHP and static assets.

- `packages/xph/`: compiler and command-line tools.
- `packages/language-server/`: language server.
- `packages/vscode/`: VS Code extension and syntax definitions.
- `examples/basic/`: example application.
- `tests/`: regression tests.
- `scripts/`: packaging and development scripts.
- `website/`: project website.

## Build, Test, and Development Commands

Use Node.js 22.12+ and the pinned pnpm version in `package.json`. Install dependencies with `pnpm install`.

- `pnpm build`: build the compiler, language server, and VS Code extension.
- `pnpm test`: run Vitest tests.
- `pnpm check`: check TypeScript, lint, and formatting.
- `pnpm lint`: run Oxlint.
- `pnpm format`: format with Oxfmt.
- `pnpm test:package`: run package smoke tests.
- `pnpm --filter xph-example-basic build`: build the example application.

## Coding Style & Naming Conventions

Match surrounding code. TypeScript uses tabs, single quotes, semicolons, and a 100-column limit. Use Oxfmt for formatting and Oxlint for linting.

## Testing Guidelines

Add focused regression cases for compiler behavior changes. Review snapshot diffs before accepting updates. Run tests and checks appropriate to the affected packages.

## Commit & Pull Request Guidelines

Keep changes focused and follow the repository's commit conventions. PR descriptions should explain behavior, link relevant issues, report validation commands, and identify intentional snapshot or generated-output changes.
