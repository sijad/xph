# Repository Guidelines

## Project Structure & Module Organization

This workspace groups four independent Git repositories; the workspace root has no shared build or Git history. Run commands inside the relevant project. Preserve the directory spelling `astro-compliers/`.

- `astro-compliers/compiler/`: Go Astro compiler. Core parsing, transforms, and printing live in `internal/`; WebAssembly entry points are in `cmd/astro-wasm/`; TypeScript packages and integration tests are in `packages/`. `lib/` contains bundled dependencies.
- `astro-compliers/compiler-rs/`: Rust implementation, with Rust crates in `crates/`, TypeScript bindings in `packages/compiler/`, and language documentation in `docs/`. Read its existing `AGENTS.md` before editing.
- `old/xhp-js/`: legacy XHP/JavaScript library, with Hack source in `src/` and JavaScript in `xhpjs.js`.
- `old/xhp-js-example/`: legacy example application, with JavaScript in `js/`, generated assets in `build/`, and `example.php` as its entry point.

## Build, Test, and Development Commands

Install compiler dependencies with `pnpm install`, using each project's pinned `packageManager` version.

From `astro-compliers/compiler/`:

- `pnpm run build:all`: build WebAssembly and the compiler package.
- `go test -v ./internal/...`: run Go tests.
- `pnpm test`: run TypeScript integration tests through uvu.
- `pnpm run check`: check formatting and lint with Biome.

From `astro-compliers/compiler-rs/`:

- `pnpm run build:all`: build native bindings, astro2tsx, and TypeScript packages.
- `cargo test`: run Rust tests.
- `pnpm run build:napi && pnpm test`: rebuild bindings and run Node tests.
- `pnpm format` and `pnpm lint`: format and lint Rust/TypeScript.

Both legacy projects expose `npm run build`; neither declares an npm test script.

## Coding Style & Naming Conventions

Match surrounding code. Format Go with `gofmt`; use `*_test.go` for tests. Format Rust with `cargo fmt`, using four-space indentation and snake_case functions. Compiler TypeScript uses Biome, tabs, single quotes, semicolons, and a 100-column limit. Preserve legacy conventions when editing `old/`.

## Testing Guidelines

Add focused regression cases for compiler behavior changes. Go snapshots use go-snaps; Rust snapshots use insta and `.astro` fixtures. Review snapshot diffs before accepting updates. Rebuild Rust bindings before testing JavaScript-facing changes. No workspace-wide coverage threshold is defined.

## Commit & Pull Request Guidelines

Commit within the affected Git repository. History mixes descriptive imperative subjects and scoped fixes such as `fix(astro2tsx): ...`; follow the target project's convention. Keep changes focused. PR descriptions should explain behavior, link relevant issues, report validation commands, and identify intentional snapshot or generated-output changes.
