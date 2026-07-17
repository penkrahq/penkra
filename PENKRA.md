# Penkra Fork Notes

## Upstream Baseline

- Repository: `https://github.com/Emanuele-web04/synara`
- Release tag: `v0.5.5`
- Commit: `9be46c3ce6a7521b64436b7334bc6fce16e3cac4`
- Verified: 2026-07-16

Update this baseline after every deliberate upstream release merge.

## Phase 0 Findings

- `bun install --frozen-lockfile` succeeds with Bun 1.3.14.
- `bun run build` succeeds for the unmodified upstream release.
- An isolated web instance runs with `SYNARA_PORT_OFFSET=3158`, server port `58090`, web port
  `8891`, and state under `.synara-penkra-phase0`.
- A non-Git folder (`~/PenkraPhase0Client`) can be registered as a project and used for a Codex chat.
- Skill references use `$name`. Upstream already parses `$name` as a skill token in
  `apps/web/src/composer-editor-mentions.ts`; `@name` is reserved for file/plugin/agent mentions.
  Penkra skills must remain server-backed and load through `penkra skill load`, not Synara's local
  skill-file injection.
- Project pinning exists server-side through the project `isPinned` field. The browser-local
  `pinnedProjectsStore.ts` is a separate UI preference and is not the Penkra HQ authority.

## Known Baseline Warning

The server's login-shell PATH discovery can time out on `/bin/zsh`, but startup falls back and the
server becomes healthy. Re-test provider executable discovery after the provider spawn integration.

## Phase 0 Merge-Surface Notes

- `apps/server/src/main.ts` already resolves `SYNARA_HOME`/`--home-dir` into `ServerConfig.baseDir`.
  Desktop bootstrap should set `SYNARA_HOME`; no alternate storage root is needed.
- `apps/server/src/config.ts` owns both default workspace roots. Change only
  `resolveDefaultChatWorkspaceRoot` to `<home>/Penkra/.scratch`; keep Studio derived beneath that
  scratch root. Client and HQ projects are registered explicitly from `<home>/Penkra`, not inferred
  from the scratch path.
- `apps/server/src/serverLayers.ts` is the composition point for long-lived services. The Penkra
  backend client, registry sync, socket, and scaffold services should be one merged Effect layer
  provided by `main.ts:LayerLive`, alongside the existing runtime/provider layers.
- Provider environment is centralized rather than assembled in UI code. Codex goes through
  `apps/server/src/codexProcessEnv.ts:buildCodexProcessEnv`; Claude uses
  `apps/server/src/provider/claudeProcessEnv.ts:buildClaudeProcessEnv`; other adapters have
  equivalent builders. Inject `PENKRA_CONFIG` and `PENKRA_SESSION_ID` at the session launch
  boundary after resolving the project workspace, while preserving the existing provider env.
- Provider adapters already launch with the thread/session `cwd` (for example the Codex adapter
  passes `input.cwd` to the app-server request). This makes git-style `.penkra/config.json`
  discovery valid for every project without a provider-specific path argument.
- The project row is rendered by `renderProjectItem` in
  `apps/web/src/components/Sidebar.tsx`. Its trailing slot already combines run and collapsed-thread
  status without shifting the label. Add the todo badge there as another fixed-width trailing
  signal and source it from the Penkra store; do not overload Synara's thread status glyph.
- Server-side `project.isPinned` is the authoritative HQ pin. Registry sync should enforce HQ
  pinned and client projects unpinned through existing project update commands; the local pinned
  preference remains a UI optimization only.
