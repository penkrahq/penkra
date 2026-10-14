# Re-run the isolated native reproduction

These are diagnostic harness files, not product replacements. Run them only against an archived scratch copy. They contain a synthetic caller thread/folder and a local Browser App document; they do not require account authentication or model calls.

1. Archive commit `b2b81bd032ac7ac9becac760dc7a7d12da11f1e3` into a new scratch root's `source` directory. Create sibling `qa-home` and `evidence` directories. Link the existing checkout's dependency trees into the archived root, `apps/web`, `apps/server`, `apps/desktop`, and the contracts/shared/ui packages. Do not install dependencies or modify the live checkout.
2. Copy this harness directory's files into `source/qa`. Link `source/qa/node_modules` to `source/apps/web/node_modules` so the fixture renderer resolves React. From `source`, run `python3 qa/prepare.py`. This generates fixture renderer files and Vite configuration, and captures the unchanged main-process source fragments. It does not alter product source files.
3. From `source/apps/web`, launch the fixture renderer with explicit isolation:

   ```sh
   PENKRA_HOME=<scratch>/qa-home PENKRA_PORT=3909 \
   VITE_DEV_SERVER_URL=http://localhost:5909 VITE_WS_URL=ws://localhost:3909 \
   bun run dev --config qa-vite.config.ts
   ```

4. From `source`, select a diagnostic run and bundle it:

   ```sh
   QA_RUN=run1 bun qa/build.mjs
   ```

   `run1` is the six-case baseline/collapsed/native-hidden/hide/minimize/already-hidden matrix. `run2` adds native app-hide after claim and retains the two app-hide controls whose hidden preconditions were lost. `run3` (or omitting `QA_RUN`) is the guarded before-claim and already-hidden control. Run each in a separate process. Keep separate evidence directories or preserve the previous run's files before starting another; the logger appends `events.jsonl` and replaces `results.json`.

5. Launch only the scratch harness, using the installed dependency's Electron executable (no app installation or signing):

   ```sh
   QA_ROOT=<scratch> PENKRA_HOME=<scratch>/qa-home PENKRA_PORT=3909 \
   VITE_DEV_SERVER_URL=http://localhost:5909 \
   apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron qa/bundle
   ```

The main harness owns the synthetic HTTP endpoint on `127.0.0.1:3909` and its scratch command socket. Verify the ports are available first. It never launches Penkra's production backend. Do not reuse Production paths or redirect these commands to an installed Penkra app.

`source-fragments.json` records verbatim main.ts segments and their hashes. `main-run1.ts`, `main-run2.ts`, and `main.ts` are the actual assembled programs used. `main-prefix*`/`main-suffix*` preserve their construction pieces. Diagnostic gates are confined to the fixture presentation wrapper and the before-claim control. The actual activation class, route selection, tab host, dock components/store, command parser, and 30,000 ms client limit remain product imports.

Existing class/routing controls were run from `source/apps/desktop` using `bun run test src/appTabActivation.test.ts src/appTabOpenedRouting.test.ts`; all 15 passed. Stop only the harness's Electron and Vite processes when done. Do not stop another thread's scratch instance if its ports are occupied.
