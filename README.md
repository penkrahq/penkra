# Penkra

Penkra is a desktop workspace for knowledge work with AI agents. Its product design
comes from `penkra.pen`; native React components reproduce that design while retaining
the application's production routing, state, accessibility, and desktop behavior.

This repository continues from the archived Penkra Console Git history so Penkra can
retain its proven desktop, provider, storage, browser, packaging, and release
infrastructure. Pencil is the visual and structural authority; exported HTML is not an
application runtime.

## Development

Install dependencies:

```sh
bun install --frozen-lockfile
```

Install the macOS development launcher:

```sh
bun run dev:desktop:install-app
```

Opening `/Applications/Penkra (Dev).app` starts the complete local development workspace
and launches the desktop application as **Penkra (Dev)**. The launcher starts Docker Desktop
when necessary and waits for its engine before bootstrapping the workspace. Startup state is
written to `~/Penkra_Dev/.launcher/status.json`; a failed startup presents Retry and View Log
actions instead of exiting silently.

Source builds use Penkra's production account services by default, so public contributors can
sign in with an ordinary Penkra account without running the private backend. Internal development
sets both `PENKRA_API_URL` and `PENKRA_AUTH_ORIGIN` to the local backend and website. A custom
compatible service must set both values together; see `.env.example`.

Run the component library:

```sh
bun run --cwd apps/web storybook
```

This is one independent repository organized as a Bun workspace. From its root,
`bun run test` runs the test task in each internal workspace package; it does not
cross into `penkra-website` or `penkra-backend`.

## Repository structure

- `penkra.pen` — desktop product-design source
- `apps/web/src/components/foundations` — Pencil Foundations components
- `apps/web/src/components/onboarding` — Pencil Onboarding components
- `apps/web/src/components/apps` — Pencil Apps components
- `apps/web/.storybook` — isolated component states and design mappings
- `apps/desktop` — Electron lifecycle, native integration, identity, IPC, and updates
- `apps/server` — local server, provider harnesses, threads, filesystem, and browser runtime
- `packages/contracts` — shared application contracts
- `packages/shared` — reusable runtime and domain utilities

Pencil components are implemented with the existing React primitives and composed into
the existing router. As each remaining Pencil group is migrated, it receives the same
named folder beside these groups. Storybook records variants and Pencil node mappings
without shipping any iframe or exported-screen runtime in production.
