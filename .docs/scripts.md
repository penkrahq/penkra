# Scripts

- `bun run dev` — Starts contracts, server, and web in `turbo watch` mode.
- `bun run dev:server` — Starts just the WebSocket server (uses Bun TypeScript execution).
- `bun run dev:web` — Starts just the Vite dev server for the web app.
- `bun run dev:desktop:install-app` — Installs `Penkra Dev`, `Penkra Dev 2`, and `Penkra Dev 3` in Applications. Launching any installed slot starts the shared local services and that slot's isolated desktop state.
- `bun run dev:desktop:install-app -- <slot>` — Installs another stable numbered desktop slot, such as `Penkra Dev 4`.
- `bun run dev:desktop` — Low-level foreground desktop/watch command used by the launcher and specialized debugging. It is not the numbered multi-instance workflow.
- Dev commands default `PENKRA_HOME` to `~/.penkra`, which keeps dev state under `~/.penkra/dev`.
- Override server CLI-equivalent flags from root dev commands with `--`, for example:
  `bun run dev -- --home-dir ~/.penkra-2`
- `bun run start` — Runs the production server (serves built web app as static files).
- `bun run build` — Builds contracts, web app, and server through Turbo.
- `bun run typecheck` — Strict TypeScript checks for all packages.
- `bun run test` — Runs workspace tests.
- `bun run dist:desktop:artifact -- --platform <mac|linux|win> --target <target> --arch <arch>` — Builds a desktop artifact for a specific platform/target/arch.
- `bun run dist:desktop:dmg` — Builds a shareable macOS `.dmg` into `./release`.
- `bun run dist:desktop:dmg:x64` — Builds an Intel macOS `.dmg`.
- `bun run dist:desktop:linux` — Builds a Linux AppImage into `./release`.
- `bun run dist:desktop:win` — Builds a Windows NSIS installer into `./release`.

## Desktop `.dmg` packaging notes

- Default build is unsigned/not notarized for local sharing.
- The DMG build uses `assets/macos-icon-1024.png` as the production app icon source.
- Desktop production windows load the bundled UI from `penkra://app/index.html` (not a `127.0.0.1` document URL).
- Desktop packaging includes `apps/server/dist` (the `penkra` backend) and starts it on loopback with an auth token for WebSocket/API traffic.
- Your tester can still open it on macOS by right-clicking the app and choosing **Open** on first launch.
- To keep staging files for debugging package contents, run: `bun run dist:desktop:dmg -- --keep-stage`
- To allow code-signing/notarization when configured in CI/secrets, add: `--signed`.
- Windows `--signed` uses Azure Trusted Signing and expects:
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Azure authentication env vars are also required (for example service principal with secret):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

## Running multiple desktop instances

Install the Applications launchers with `bun run dev:desktop:install-app`, then open `Penkra Dev`, `Penkra Dev 2`, or `Penkra Dev 3`. Additional slots use `bun run dev:desktop:install-app -- <slot>` once and then launch normally from Applications.

Numbered desktop Apps share source watchers, the renderer, website, account API, and registry. Their login/session, Chromium profile, Penkra database, tabs, Threads, logs, bundle identity, locks, and embedded backend are isolated. Do not create numbered desktop Apps with environment variables, copied bundles, renamed executables, or manually selected ports.

## Isolating browser/server ports

`PENKRA_DEV_INSTANCE` and `PENKRA_PORT_OFFSET` belong to the low-level dev runner's browser/server port selection. They do not create a numbered Penkra Dev desktop identity.

- `PENKRA_DEV_INSTANCE=branch-a bun run dev` deterministically shifts the browser/server port set.
- `PENKRA_PORT_OFFSET=<number> bun run dev` selects an explicit offset.
