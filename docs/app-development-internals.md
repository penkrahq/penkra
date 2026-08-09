# Penkra App-platform development internals

This document is for contributors working on Penkra itself. App authors should use the public
[`Build a Penkra App`](app-development.md) guide instead.

## Product and registry environments

Desktop flavor and account-service environment are separate concerns:

- Ordinary Penkra uses production account services by default.
- A direct source launch also uses production account services when `PENKRA_API_URL` and
  `PENKRA_WEBSITE_ORIGIN` are omitted.
- The canonical numbered `Penkra Dev` launcher deliberately overrides both values to the shared
  local backend (`http://localhost:3012`) and website (`http://localhost:3000`). Its registry is
  local, even though it runs the same App-platform implementation.

Registered App-author help and registry operations report the active registry environment and API
origin. Treat that returned target as the authority; never infer production or local state from the
desktop's display name.

## Registered commands

Every supported desktop flavor exposes the public App-author commands through
`penkra_exec_command`:

```text
penkra app test <directory>
penkra app package <directory> --output <path>
penkra app status [--app-id <app-id>]
penkra app publish <directory> [--visibility public|private]
penkra app access <invite|list|revoke> ...
```

These are registered host operations, never native executables or provider-shell commands.
Authentication and publisher ownership authorize registry mutations. The configured account-service
origin selects the registry. The public guide intentionally omits internal desktop-flavor details.

`penkra app sideload <directory>` is an additional internal contributor command exposed only by the development
desktop flavor. It installs an unpacked directory into the caller Thread's Space, watches successful
rebuilds, atomically swaps valid packages, restores App tabs, and preserves the last working package
after an invalid rebuild. It is not part of the public App-author contract.

## Numbered development launchers

`bun run dev:desktop:install-app` installs `Penkra Dev`, `Penkra Dev 2`, and `Penkra Dev 3` in
`/Applications`; additional numbered slots may be installed explicitly. The instances share source
watchers and local account/website/registry services while keeping desktop profiles, databases,
sessions, tabs, logs, and embedded backends isolated.

The launcher owns its fixed local-service routing. Do not rename a launcher, copy an app bundle, or
manually construct instance environment variables. See `AGENTS.md` for the complete isolation and
Thread-boundary rules.

Starting the local development stack applies local migrations and idempotently seeds first-party
registry Apps using the development root's persistent signing identity. Local registry publication
is evidence only for that local environment; it says nothing about production publication.

## Contributor verification

Use normal source tests while implementing the platform. Use registered `penkra app test` for the
isolated packaged runtime and the internal `sideload` command for live rebuild behavior. Complete the
fresh numbered-desktop manual QA required by `AGENTS.md` before declaring affected product flows
finished.

Keep evidence layers distinct:

- framework tests validate App or platform logic;
- `penkra app test` validates the immutable packaged runtime;
- sideload QA validates internal live-rebuild behavior;
- production registry status validates production publication;
- installed desktop QA validates a specific desktop artifact on a specific operating system.

None substitutes for another.
