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

`penkra app test` relaunches the current Electron executable through the packaged `entry.js` into an
internal App-test mode. That child uses a temporary profile and never takes the ordinary
single-instance lock or starts the embedded backend. Source launches pass the built entry path;
installed builds relaunch the packaged entry directly. Do not restore source-checkout discovery or
an external Electron prerequisite. The disposable host uses Chromium's mock keychain so its
`safeStorage` checks cannot prompt for or block on the operator's real OS keychain; ordinary Dev and
production profiles continue to use OS-backed secure storage.

The authenticated account-service session authorizes publication. The registry checks ownership
while creating the immutable version and submission, verifies the uploaded package against the
declared size and digest, runs the package validators, and signs the resulting release statement
with the registry key. App publication does not introduce a second identity provider or a
developer-held signing credential.

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

The embedded backend is the sole owner of its slot's SQLite database. Do not use the system
`sqlite3` program or any generic database tool against a running slot, including for read-only
diagnostics. Use live Penkra diagnostics while the slot is running and the lifecycle-lock-aware
`penkra-database verify` command only after every process for that slot has stopped. The complete
ownership and recovery contract is in [`database-reliability.md`](database-reliability.md).

Starting the local development stack applies local migrations and idempotently seeds first-party
registry Apps using the development root's persistent signing identity. Local registry publication
is evidence only for that local environment; it says nothing about production publication.

## Required Apps bootstrap

`com.penkra.apps` remains a normal independently versioned registry App, but Penkra also treats it
as required infrastructure. Every desktop release embeds the exact deterministic `.penkra` archive
pinned by `required-apps.lock.json`. The embedded archive enters the ordinary immutable package
ingestor, per-Space installation state, sandboxed runtime, and registry updater; it is not a second
installation mechanism.

Before ordinary remote default-App bootstrap, the desktop reconciles required Apps in every known
Space. A missing installation receives the embedded version, an older or incompatible installation
is replaced by it, and a newer compatible registry version remains active. Reusing the embedded
semantic version with different bytes is a fatal immutable-version collision. Required Apps cannot
be disabled or uninstalled. Registry availability is therefore unnecessary for startup, while a
later compatible registry release can still update Apps independently.

Packaged Penkra treats a missing, invalid, incompatible, or digest-mismatched embedded archive as a
fatal installation error and directs the user to update or reinstall. Source launches resolve the
Apps package from the sibling `penkra-apps/apps` checkout unless
`PENKRA_REQUIRED_APPS_SOURCE_PATH` explicitly selects another contributor source. That source is a
fallback for a missing required installation, not an implicit update channel: an existing required
installation remains active, and contributor changes use the explicit runtime-safe sideload flow.

## Hosted Browser surface geometry

The Browser App iframe owns browser chrome; AppDock owns the isolated Electron `<webview>`. Keep
the guest element in the trusted shell DOM so App packages cannot create Electron guests directly
and shell overlays remain above the entire App frame. Do not position it with dimensions reported
on every resize. That introduces a delayed loop through the App frame's `ResizeObserver`,
MessagePort, shell IPC, main process, host event delivery, and React.

The public `browser.setSurfaceLayout` call reports App-local `top`, `right`, `bottom`, and `left`
insets only when those structural edges change. AppDock applies all four as CSS constraints to an
absolutely positioned, flex-displayed `<webview>`. Consequently, resizing AppDock changes the
iframe and Browser guest in the same shell layout transaction without another capability call.
Tests must assert edge equality after host-only width changes; checking only the App iframe width
does not cover the Browser guest.

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
