# Archived console source map

Source snapshot: `penkrahq/penkra-console` commit `a149f2e8` on
`archive/final-console-snapshot-2026-07-28`.

This is a migration inventory, not approval to copy code. Every candidate remains gated
by `docs/DESIGN_PASS.md`.

## Strong infrastructure candidates

| Penkra capability | Archived source | Reuse approach |
|---|---|---|
| Electron window lifecycle, state, logging, and updates | `apps/desktop/src/main.ts`, `apps/desktop/src/desktopUserDataProfile.ts` | Extract narrow services; do not transplant the console bootstrap wholesale |
| Browser runtime and per-thread tab state | `apps/desktop/src/browserManager.ts`, `apps/desktop/src/browserIpc.ts`, `apps/desktop/src/browserSessionPolicy.ts` | Adapt after Browser panel and tab states are approved |
| Browser UI behavior | `apps/web/src/components/BrowserPanel.tsx`, `apps/web/src/components/BrowserPanel.logic.ts` | Reuse state and navigation logic; rebuild presentation against the approved Penkra design |
| Workspace filesystem boundary | `apps/server/src/workspace/Services/WorkspaceFileSystem.ts`, `apps/server/src/workspace/Layers/WorkspaceFileSystem.ts` | Reuse permission-safe service concepts after Files states are approved |
| PDF viewing | `apps/web/src/components/PdfFilePreview.tsx`, `apps/web/src/components/pdf/` | Reuse rendering and lifecycle logic inside the Files + Editor app |
| Thread persistence and lifecycle | `packages/shared/src/chatThreads.ts`, `packages/shared/src/threadWorkspace.ts`, `apps/server/src/orchestration/` | Adapt the data model to Penkra's Folder → Thread → Chat structure |
| Codex harness integration | `apps/server/src/codexAppServerManager.ts`, `apps/server/src/codexAppServerTransport.ts` | Isolate as the Codex core harness adapter |
| Claude and other provider adapters | `apps/server/src/provider/`, `apps/server/src/provider/Layers/` | Evaluate adapter by adapter; retain only shipped harnesses |
| MCP/tool injection | `apps/server/src/agentGateway/mcpInjection.ts` | Adapt naming and contracts to Penkra Apps and bundled tools |
| Provider credentials and usage | `apps/server/src/providerCredentials.ts`, `apps/server/src/providerUsage/` | Reuse parsing and secure-storage boundaries after Account/Agents designs are complete |
| Voice capture and transcription | `apps/desktop/src/voiceTranscription.ts`, `packages/shared/src/voiceTranscriptionAudio.ts` | Defer until the composer behavior is approved |

## Reuse only as implementation reference

- `apps/web/src/routes/_chat.tsx` contains useful shell, shortcut, and thread coordination
  behavior, but its presentation and route composition are console-specific.
- `apps/web/src/components/SidebarThreadRowContent.tsx` and related thread stores can
  inform thread behavior, but the archived sidebar does not define Penkra's final
  navigation contract.
- `packages/contracts/src/provider*.ts` provides mature provider types, but the contract
  surface must be reduced to Penkra's fixed core harness set.
- `apps/server/src/orchestration/` contains durable concurrency and persistence ideas,
  but it assumes the console's existing storage and event model.

## Excluded from Penkra core

These archived areas conflict with settled v1 architecture and should not be ported into
the core application:

- `apps/web/src/components/terminal/`
- `apps/web/src/ThreadTerminalDrawer.tsx`
- `apps/server/src/terminal/`
- `packages/contracts/src/terminal.ts`
- Git and pull-request UI under `apps/web/src/components/Git*`,
  `apps/web/src/components/pullRequest/`, and `apps/server/src/git/`
- Diff/review surfaces such as `ReviewFileTreePanel.tsx` and `DiffPanelFileList.tsx`

They may become later Apps or developer extensions, but they are not core source
migration targets.

## Recommended migration order

1. Desktop lifecycle and local data directories.
2. Folder, thread, and chat persistence.
3. One harness end to end, starting with Codex or Claude after the onboarding decision.
4. Filesystem service and the Files + Editor app.
5. Browser manager and Browser app.
6. Provider credentials, model discovery, and usage.
7. Remaining approved recovery, update, and permission services.

Each step should introduce its own contract and tests instead of importing the archived
console dependency graph.

