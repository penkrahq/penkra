# Addition harness

Run only in an isolated archive of source a0a576730, with scratch provider/profile homes. Never use Production state or an installed Penkra application. This is a native diagnostic fixture, not an installed numbered Dev app. No provider calls are made. The original harness README one directory level above describes dependency symlinks and fixture fidelity.

Create a fresh scratch root and archive checkout under `source`. Copy this directory to `source/qa`, omitting this README if desired. Reuse existing repository dependencies by symlink; do not install anything. Create `<scratch>/qa-home`, `<scratch>/evidence` and `<scratch>/app-storage/upload-fixture.txt` (a harmless text file). Set `QA_ROOT` to that scratch root, and run from `source`.

`prepare.py` extracts the real main routing/diagnostic/IPC/window listeners and generates renderer/preloads/stubs. It originally generates port 5909; change only its generated diagnostic `qa-vite.config.ts` to **5919**, or copy the retained `qa-vite.config.ts`. Its renderer HTML must use the new absolute scratch `/@fs/…/qa/renderer.tsx` path. Ports must be free; leave unrelated processes alone.

Start Vite from `source/apps/web`:

```sh
PENKRA_HOME="$QA_ROOT/qa-home" PENKRA_PORT=3919 VITE_DEV_SERVER_URL=http://localhost:5919 VITE_WS_URL=ws://localhost:3919 bun run dev --config qa-vite.config.ts
```

Apply `../matrix/guard-bypass.patch` only in the archive, never the release worktree. It adds the diagnostic environment early return in `#requireActive`; the main matrix toggles this environment flag itself. Build and launch from the archive root:

```sh
QA_ENTRY=qa/main-commands.ts bun qa/build.mjs
PENKRA_HOME="$QA_ROOT/qa-home" PENKRA_PORT=3919 VITE_DEV_SERVER_URL=http://localhost:5919 apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron qa/bundle
```

`main-commands.ts` runs f plus g, `main-repeat.ts` repeats the hidden bypass cases. Both import real product classes; their server backend and services are fixtures. `commands-run.ts` is the composition template; `audit-commands.ts` the g body. The retained complete main entries are the executed sources, rather than requiring template substitution.

The (e) investigation was withdrawn after its evidence was collected; the following is archival reproduction guidance, not current task scope. For the final native e controls, start `osascript -l JavaScript qa/visibility-helper.js` with `QA_ROOT` set, then build `QA_ENTRY=qa/main-visibility.ts` and launch as above. Ensure a prior `helper-control.json` quit command is removed before starting a new helper. The final entry contains native activation/hide/full-screen/coverage controls; denied physical keyboard/click/Mission Control/Stage Manager observations are preserved in the initial run logs and described in the report. Physical actions need macOS Accessibility; do not infer that a denied action took place. Do not enable OS settings without the user's response.

The helper writes its own window style mask, PID, frontmost PID and visibility. It consumes only the scratch helper-control file and exits on quit. It may alter the user's temporary foreground/Space position during native full-screen testing; no OS settings are changed. Complete coverage/z-order was not independently established. Background flag/page-state getters and command readback can wake renderer work.

Every run writes the same scratch evidence filenames; move them into separate run directories before the next run. Raw page-event arrays are cumulative within a cell: attribute events by matching action ID and command-issued timestamp, not merely their presence in the next readback. `assemble-report.py` retains the original absolute scratch/report destination; inspect/adapt those paths before any reuse. It writes only QA documentation. `error-catalog.mjs` uses TypeScript AST extraction over documented tab-path source ranges and includes shared parser source sites; classifications were added by the report assembly script.

Two early helper builds failed their full-screen preconditions and are preserved as excluded evidence. An occupied scratch backend port also caused rejected launches while a failed prior fixture process was exiting; those failed launches are not measured cases. Stop only verified own scratch processes if cleanup is needed. No signing, installation, provider account or paid model call is necessary.
