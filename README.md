# Penkra

Penkra is a desktop workspace for knowledge work with AI agents. Its product design
comes from `penkra.pen`; the application reproduces that design verbatim.

This repository continues from the archived Penkra Console Git history so Penkra can
retain its proven desktop, provider, storage, browser, packaging, and release
infrastructure. The former console interface is not the product design and is not the
active renderer.

## Development

Install dependencies:

```sh
bun install --frozen-lockfile
```

Install the macOS development launcher:

```sh
bun run dev:desktop:install-app
```

Opening `/Applications/Penkra Dev.app` starts the complete local development workspace
and launches the desktop application as **Penkra (Dev)**.

Run the Pencil-renderer verification:

```sh
bun run --cwd apps/web test:new-ui-smoke
```

## Repository structure

- `apps/web/src/new-ui` — active Pencil-authoritative renderer and interactions
- `apps/web/public/pencil` — exported Pencil screens and image assets
- `apps/desktop` — Electron lifecycle, native integration, identity, IPC, and updates
- `apps/server` — local server, provider harnesses, threads, filesystem, and browser runtime
- `packages/contracts` — shared application contracts
- `packages/shared` — reusable runtime and domain utilities

The former renderer remains in `apps/web/src` while its useful capabilities are mapped
into the new interface. It is removed incrementally after replacements are verified.
See `docs/NEW_UI_MIGRATION.md`.
