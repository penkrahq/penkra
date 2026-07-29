# New UI migration

## Authority

`penkra.pen` is always the product-design source of truth. The active renderer
reproduces its exported screens and interaction states. `PENKRA.md` and `STORIES.md`
guide architecture and product behavior only where they agree with Pencil.

The archived console source is an implementation library. It does not define the new
interface or information architecture.

## Preserved lineage

- `main` continues from archived console snapshot `a149f2e8`.
- `prototype/pencil-ui-2026-07-28` preserves standalone prototype commit `30c40e1`.
- The separate `penkra-console` repository remains archived and unchanged.
- The new public repository is `https://github.com/penkrahq/penkra`.

## Active integration

- `apps/web/src/bootstrap.ts` boots `apps/web/src/new-ui/main.tsx`.
- `apps/web/src/new-ui` contains the Pencil screen host and interaction runtime.
- `apps/web/public/pencil` contains the exported Pencil screens and assets.
- The former renderer remains present but dormant while reusable behavior is mapped.
- The desktop shell skips the former native HQ-auth overlay because it is not part of
  the current Pencil flow.
- The workspace launcher now resolves the `penkra` checkout rather than
  `penkra-console`.

## Retained foundation

- Desktop identity, single-instance behavior, window management, native menus, IPC,
  browser sessions, media permissions, diagnostics, packaging, signing, and updates
- Embedded local server and provider harnesses
- Thread, filesystem, browser, PDF, credentials, and orchestration infrastructure
- Contracts, shared utilities, tests, build tooling, and release tooling

Internal `@synara/*` package names remain temporarily. Renaming them is a mechanical
cleanup and must not block product integration.

## Pruning rule

Do not delete a former console domain merely because its old screen is absent. First:

1. map the capability to a Pencil surface or mark it excluded by product direction;
2. connect or replace the retained runtime behavior;
3. add verification for the replacement;
4. remove the old UI and then any source proven unreachable.

Terminal, Git/PR review, and console-specific workspace concepts are excluded from the
new core unless a later Pencil design explicitly introduces them.

## Current verification

`bun run --cwd apps/web test:new-ui-smoke` verifies the production renderer across:

`onboarding → workspace → settings suite → permission`

The macOS development runtime additionally verifies:

- application name and executable: `Penkra (Dev)`;
- bundle identifier: `com.penkra.app.dev`;
- valid ad-hoc signature after development-bundle customization;
- the new repository owns the desktop and embedded server processes;
- local workspace API and renderer endpoints are healthy.

## Next implementation sequence

1. Complete every remaining Pencil overlay, menu, hover, keyboard, empty, loading,
   error, and narrow-window state.
2. Add image-based regression comparisons against Pencil exports.
3. Define the new renderer-to-core boundary using retained contracts.
4. Connect onboarding and provider credentials.
5. Connect folders, threads, composer streaming, and message history.
6. Connect Files, Browser, and PDF capabilities.
7. Connect Apps, connectors, permissions, settings, and account surfaces.
8. Prune superseded renderer domains after each vertical slice passes verification.
