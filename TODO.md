# Penkra 0.14.4: clean core

Status: APPROVED by the operator on 2026-10-09 for all steps. Proceed step by step without waiting between steps. Stop and report only when (a) the evidence contradicts this plan, or (b) this plan does not say what to do. Never fill a gap by choosing yourself; a gap is a defect in this document, and the reviewer fixes the document.

One working tree, one implementer (operator, 2026-10-10): all work happens in `penkra-worktrees/release-0143` on `main`, by the implementation thread. The reviewer thread edits only this file and `docs/`. The local 0.14.3 interaction-freeze correction that an external Codex chat left uncommitted here is preserved as tag `archive/local-0143-freeze-correction`; it is what Production runs today, and steps 10-11 supersede it.

## 0. Rules

1. **Where:** work directly on `main` in `penkra-worktrees/release-0143`. Do not create worktrees or branches. Never run a bare `git stash`.
2. **Tags:** local tags only, and only of two kinds: `archive/*` (preserving something being removed) and `v0.14.4` (when the operator asks for the release). Never push anything; never publish anything.
3. **Production:** never write to the Production database (`~/Penkra/.penkra/userdata/state.sqlite`) or `/Applications/Penkra.app` by hand. Read Production only with `file:<path>?mode=ro&immutable=1` for counts and schema. A copy for rehearsal is made only as described in 3.0. Production on this Mac is updated locally after major changes, before any public release, so the operator can use them first (operator, 2026-10-10); that happens only through 5.A and only when the operator asks.
4. **Clean cuts:** no legacy compatibility code, no flags that bring back the old path, no patches on top of the old design, no one-time importers of old client-side state (localStorage, old keys). Code that the new design no longer calls is deleted in the same commit as the change that orphaned it, together with its tests.
5. **No guessed numbers:** no fixed timeouts, retries, delays or polling intervals in product code. Wait for the event that means "done" (a response, a process exit, a provider event, a DOM/ResizeObserver event). The only numbers allowed are the ones this document states with their reason (2.1 `data` limit 64 KB and page size 50, 2.6 draft debounce 300 ms, 2.8 query target 50 ms). Test code may use the test runner's overall test timeout; it may not sleep.
6. **Commits:** one or more commits per step. Each commit is titled `Step N (<part>): <what>`, passes `bun typecheck`, `bun lint` and the affected test suites, and its message lists the commands run and their results. Never commit a failing or skipped test; never delete a test to make a commit green. A test that is no longer meaningful because its feature was deleted by this plan is deleted with that feature, and the commit message names it.
7. **Reporting:** after each commit, post in the thread: commit id, what changed, test commands and results, and anything the plan did not cover. Questions the plan does not answer go to the reviewer in that same message; continue with the next item that does not depend on the answer.
8. **Base:** `origin/main` = `v0.14.3` = `445bc9b8c`.

## 1. Why (evidence)

- **Stalls:** `apps/server/src/persistence/NodeSqliteClient.ts` uses one `DatabaseSync` behind `Semaphore.make(1)`, so every read waits behind every write. The snapshot query `listThreadSummaryActivityRowsByThread` (`ProjectionSnapshotQuery.ts`) once held that connection for 1,333,270 ms.
- **Bookkeeping, not chats, fills the database:** Production is 12.4 GB, about 4.2 GB of it free pages. 576 threads at planning (579 on 2026-10-10), 82,805 messages, 1,017,954 activities, 386,587 operations, 767,001 orchestration events, 820,000 command receipts, 47,247 runtime events, 43,299 outbox rows. Tool payloads store input and diff 3 to 4 times.
- **Drift:** turn state is rebuilt from commands, receipts, events and projections, then "repaired" by `ProviderRuntimeReconciler.ts`. On 2026-10-10, `projection_turns` holds 59 `running` turns across 28 threads and 508 `queued` turns that will never run.
- **Ordering:** steering messages are placed by queue time instead of the moment the provider received them.
- **Freezes and failed sends (verified 2026-10-10):** in installed 0.14.3 every desktop diagnostics write took a cross-process lock on the Electron main thread and slept up to 5 s (`Atomics.wait`) while the server held it. That froze typing and clicks and made the desktop miss the server's 10 s credential deadline, so sends failed.

## 2. Target design

### 2.1 Data model

Tables kept unchanged: `projection_spaces`, `projection_folders` (plus one new column, 2.12), `space_navigation_state`, `auth_sessions`, `auth_pairing_links`, `provider_connections`, `provider_credential_profiles`, `provider_installations`, `managed_attachment_blobs`, `managed_attachment_cleanup_jobs`, `connection_usage_daily`, `connection_usage_turn_events`, `thread_harness_states` (its `thread_id` foreign key moves from `projection_threads` to `threads`, because `projection_threads` is dropped), `effect_sql_migrations`. They are not renamed.

```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY,                  -- chosen by the client (UUID) before the create call
  space_id TEXT NOT NULL,
  folder_id TEXT NOT NULL REFERENCES projection_folders(folder_id), -- 2.18
  title TEXT NOT NULL,
  provider TEXT NOT NULL,               -- codex | claudeAgent | opencode
  connection_id TEXT,                   -- NULL = provider's anonymous route
  model TEXT NOT NULL,
  model_options TEXT,                   -- JSON object, provider-specific
  runtime_mode TEXT NOT NULL,           -- copied from projection_threads.runtime_mode
  provider_session_id TEXT,             -- provider-native resume id (3.2)
  native_state_id TEXT,                 -- folder with the provider's own conversation files
  state TEXT NOT NULL,                  -- idle | running | error (2.3)
  active_turn_id TEXT,                  -- provider turn id; set and cleared only by the stream consumer
  last_error TEXT,                      -- set when state becomes 'error'; cleared when a turn starts
  draft TEXT, draft_updated_at TEXT,    -- 2.6
  queue TEXT NOT NULL DEFAULT '[]',     -- 2.4
  created_by TEXT NOT NULL,             -- user | agent | provider_native
  created_by_thread_id TEXT,            -- the agent thread that created it (created_by='agent')
  sidebar_sort_order INTEGER,
  last_activity_at TEXT,                -- updated in the same write as every item insert/update
  last_message_preview TEXT,            -- text of the latest user/text item, first 200 characters
  last_user_message_at TEXT,            -- updated when a user item is inserted
  last_visited_at TEXT,                 -- set when a window opens the thread
  open_question_count INTEGER NOT NULL DEFAULT 0, -- maintained in the same write as question items
  archived_at TEXT, deleted_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE thread_items (
  thread_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,          -- transcript position; assigned on first insert; never changes
  source_id  TEXT NOT NULL,             -- client message id, or provider item id
  turn_id    TEXT,
  kind       TEXT NOT NULL,             -- user | text | reasoning | tool | question | notice
  status     TEXT NOT NULL,             -- see the status table below
  text       TEXT,                      -- what the transcript shows and search indexes
  data       TEXT,                      -- ONE bounded JSON copy of the details
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq),
  UNIQUE (thread_id, source_id)
);
CREATE VIRTUAL TABLE thread_items_search USING fts5(text, content='thread_items', ...);
```

Item statuses (the complete set; nothing else is ever written):

| kind | statuses | terminal |
|---|---|---|
| 1, 2, 3, 5 | Done and reviewed: git setup; 4.1 inventory (`25d528d39`); bounded queries + timing (`436876bf9`); write path + publisher (`680e1da77`) | done |
| user | `sent`, `failed` | both |
| text, reasoning | `streaming`, `done`, `interrupted` | `done`, `interrupted` |
| tool | `running`, `done`, `error`, `interrupted` | `done`, `error`, `interrupted` |
| question | `open`, `answered`, `cancelled` | `answered`, `cancelled` |
| notice | `done` | `done` |

(A user message that has not reached the provider is not an item; it is in `threads.queue`, 2.4. There is no `queued` item status.)

Sidebar work status is derived in the read, never stored: `running` if `state='running'`; else `attention` if `open_question_count > 0`; else `done` if `last_activity_at > COALESCE(last_visited_at, '')`; else `idle`. `state='error'` shows as `attention`.

Old `projection_threads` columns that are NOT carried over, with the reason: `latest_turn_id` (= `active_turn_id`), `fork_source_thread_id` (0 rows use it; the `/fork` slash command is removed, operator 2026-10-10), `subagent_agent_id/nickname/role` (subagents disabled, 2.5), `pending_approval_count` (approvals removed), `pending_user_input_count` (replaced by `open_question_count`), `pinned_messages_json`, `notes` (feature deleted, 2.4), `thread_markers_json` (no code reads it), `source_turn_id`, `gateway_operation_id`, `gateway_operation_index` (replay bookkeeping, 2.2), `work_status` (derived, above), `is_pinned` (pin feature removed, operator 2026-10-10), `connection_id_selected` (no client reads it). Old `projection_thread_sessions` columns are replaced by `provider_session_id`, `state`, `active_turn_id`, `last_error`.

Write and read rules:
- The only item write: `INSERT ... VALUES (..., (SELECT COALESCE(MAX(seq),0)+1 FROM thread_items WHERE thread_id=?), ...) ON CONFLICT(thread_id, source_id) DO UPDATE SET status=excluded.status, text=excluded.text, data=excluded.data, updated_at=excluded.updated_at`. The same transaction updates the thread's `last_activity_at`, `last_message_preview`, `last_user_message_at`, `open_question_count` as they apply.
- `data` is at most 64 KB per item (reason: one tool output must never dominate a page read). A larger tool output is cut to 64 KB and `data` records `"truncated": true` and the original byte length. Exactly one copy: no `state.input`, `metadata.diff`, `filediff.patch` duplicates.
- Transcript reads: `WHERE thread_id=? AND seq < ? ORDER BY seq DESC LIMIT 50` (50 = one screen with margin). Sidebar and summaries read `threads` only. No query scans items across threads.

### 2.2 No receipts, no event journal

- **Create** (thread, message): the client generates a UUID first; the server runs `INSERT ... ON CONFLICT(id) DO NOTHING`, so a resend after a dropped connection does nothing and returns the existing row.
- **Set state** (archive, unarchive, rename, move, delete, answer, stop): a plain `UPDATE` to the target value; repeating it changes nothing.
- Each operation is one function: validate input, write rows in one transaction, publish a change notification. Delete the command/receipt/event/projection pipeline: `OrchestrationEngine`, `OrchestrationReactor`, `ProjectionPipeline`, `projector.ts`, `decider.ts`, the receipts/events/deliveries/consumer tables, `provider_intent_outbox*`, `providerIntentOutboxWorker.ts`.
- Live updates: one in-memory publisher per thread. A window subscribes and receives changed rows; on reconnect it re-reads pages from the database. Nothing is persisted for the stream.

### 2.3 Turn state

- One consumer per thread applies the provider's ordered events: `turn started` → `state='running'`, `active_turn_id=<id>`, `last_error=NULL`. Each item event → the upsert. `turn ended` with `completed` or `interrupted` → `state='idle'`, `active_turn_id=NULL`; with `error` → `state='error'`, `active_turn_id=NULL`, `last_error=<provider message>`. In the same write, every item of that thread still `running` or `streaming` becomes `interrupted` (`settleRunningItems`).
- A turn ends only on the provider's end event, or on these two cut-offs: (a) the provider process exits; (b) Penkra starts. On a cut-off, each affected thread gets `state='idle'`, its running/streaming items become `interrupted`, and one `notice` item "This turn was cut off because the provider stopped." Work is not resumed automatically.
- A turn that fails to start (credential, launch or validation error) never becomes running: the thread keeps its previous `state`, no `user` item is inserted, and the send returns `failed` (2.4).
- `state='error'` does not block anything: the next send starts a turn normally.
- Archive is allowed unless `state='running'`. Stop: send the provider its interrupt; the state changes when the provider's end event (or a process exit) arrives. The Stop button shows "Stopping…" until then.
- There is no turns table. A turn is identified only by `threads.active_turn_id` while it runs and by `thread_items.turn_id` afterwards.
- Delete: `ProviderRuntimeReconciler`, `restartTurnRecovery.ts`, `startupTurnReconciliation.ts`, unused parts of `turnLifecycle.ts`, and the `provider_runtime_*`, `restart_turn_recoveries`, `queued_turn_promotions` tables.

### 2.4 Sending, queue, steer, interrupt

Queue:
- `threads.queue` is a JSON array of `{ messageId, text, attachments, senderThreadId, dispatchOrigin, queuedAt }`, oldest first. The server holds the same array in memory and writes it on every change.
- Send without `now`: if `state` is not `running` and the queue is empty, deliver now. Otherwise append to the end of the queue.
- When a turn ends (any end event or cut-off), deliver the head of the queue, if any.
- If delivering the head fails to start (2.3), the head stays at the head, the thread gets `state='error'` with `last_error`, and nothing more is delivered until the next send to that thread (which first retries the head) or until the user removes or edits the head.
- Send with `now`: Codex and Claude: native steer of the running turn. OpenCode: interrupt the running turn, then deliver this message as the next turn ahead of the queue. If nothing is running, `now` behaves like a plain send.
- Delivery inserts the `user` item with `status='sent'` at that moment (so it sits exactly where the provider received it).

Send result. The call returns only when exactly one of these is true; there is no timer:

| delivery | returned when | extra fields | meaning for the caller |
|---|---|---|---|
| `started` | the provider emitted `turn started` for this message | `turnId` | The agent is working on it. Read the thread for output. |
| `steered` | the provider acknowledged the steer request (`now`, Codex/Claude) | `turnId` (the running turn) | The running turn received it. |
| `interrupted` | the old turn ended and this message's turn started (`now`, OpenCode) | `turnId` | The old turn was stopped; this message is being worked on. |
| `queued` | the message was appended to `threads.queue` | `position` (1 = next to be delivered), `queueLength`, `runningTurnId` (`threads.active_turn_id`, or null when the head is blocked by an error) | Not seen by the agent yet. It is delivered automatically when everything ahead of it finishes. Use `now` only if it must interrupt. |
| `failed` | the launch or provider rejected it, or the provider process exited before `turn started` | `error` (the provider's message, unchanged) | Nothing was delivered. The message is not in the transcript. Fix the cause and send again. |

- Every result also returns `threadId` and `messageId`. There is no `blockingTurnStartedAt`, no estimate.
- Today's `AgentGateway.ts:454-540` guesses this from projection snapshots; it is replaced by the table above.

Interrupt (`penkra threads interrupt`): `--thread-id` alone interrupts the thread's running turn (no effect if none). `--message-id <id>` removes that message from `threads.queue` (no effect if not queued). There is no `--turn-id`. Evidence for removing it (2026-10-10 04:10Z): interrupting a stale `turn_id` interrupted the thread's real running turn and left the stale row `running`.

Editing a queued message (operator, 2026-10-10): in the composer's queue list, "Edit" works only when the composer is empty, meaning no text, no attachments and no files.
- Composer empty: Edit removes the message from `threads.queue` and writes its text and attachments into the thread draft, in one write. The composer then shows it exactly once.
- Composer not empty: Edit changes nothing (the queue and the draft stay as they are) and shows the existing toast (the one at the top middle of the chat), with the exact title "Clear or send your message before editing a queued one."
- The server operation enforces the same rule: inside its transaction, if the stored draft is not empty it fails with that same message and writes nothing.
- Tests:
  - empty composer: Edit leaves the queue empty and the composer holding the text exactly once (operator-reported duplicate bug);
  - composer with text: Edit leaves the queue and the draft unchanged and shows the toast;
  - server: a non-empty draft fails, rolls back and publishes nothing.

Removed features:
- Editing sent user messages (operator, 2026-10-09): delete `packages/shared/src/conversationEdit.ts`, `resolveTailUserMessageEditTarget` and its ChatView wiring. Stop and resend is the correction path.
- Pinned messages and thread notes (operator, 2026-10-09): delete `pinnedMessages.ts`, `usePinnedMessageActions.ts`, `@penkra/shared/pinnedMessages`, the `PinnedMessage` contracts and pin/notes commands, and the `onTogglePinMessage`/`pinnedMessageIds` wiring.
- Pinning in the sidebar, for threads and folders (operator, 2026-10-10):
  - Delete the `is_pinned` column from migration 176. That migration has not shipped, so edit it in place; remove the column from the table, the backfill and `idx_threads_sidebar_order`.
  - Delete the clean-core `pin` update action, `pinnedFoldersStore.ts`, `pinning.logic.ts`, the pin and unpin menu items, pin icons on rows and deck tabs, the `isPinned` fields in contracts and web types, the folder pin code in `decider.ts`, and every pin test.
  - Sidebar order becomes `sidebar_sort_order`, then `created_at DESC`, then `id`.
  - Done when `git grep -n -i "pin" -- apps packages` shows no sidebar or deck pin code outside old migrations.

### 2.5 Questions, approvals, subagents

- Questions (Codex `item/tool/requestUserInput`, Claude `AskUserQuestion`, OpenCode `question.asked`) are `kind='question'` items, `status='open'`. Answering updates the same row to `answered` with the answer in `data`; a turn that ends with the question still open sets it to `cancelled`.
- Approvals: removed entirely, UI and code. Every provider runs without approval prompts.
- Subagents disabled: Claude `disallowedTools: ["Task","Agent"]`; OpenCode `tools: { task: false }`; Codex `features.multi_agent=false`.

### 2.6 Composer draft

- One draft per thread in `threads.draft`, a JSON object with: text, attachments (`{ id, name, mimeType }`; files stay in the shared local `composer-drafts-v1/assets/` folder), pasted-text blocks, file comments, mentions, skills, assistant selections, terminal contexts, model selection, runtime mode. Only a live voice recording and prompt-history browsing stay in the window.
- A window writes the draft 300 ms after the last keystroke (reason: other windows update while you type without one write per keystroke). The server broadcasts it; other windows showing the thread replace their draft with it. The write with the later `draft_updated_at` wins.
- Sending clears `threads.draft` in the same write that queues or delivers the message.
- Expired terminal contexts: when a send omits a terminal context because it expired, the composer shows the warning "Expired terminal context omitted…" (existing text). This must work with the draft read from `threads.draft`.
- The per-window localStorage draft persistence is deleted, not blanked; old localStorage drafts are not imported.

### 2.7 Attachments and OpenCode images

- Keep `managedAttachmentStore.ts`: files on disk; the provider receives paths.
- OpenCode: an `experimental.chat.messages.transform` hook keeps image parts only in the newest user message and replaces each image in older messages with the text `[image: <path>]`. No media tables. Test: a conversation with 25 images keeps working and only the newest message carries image parts.

### 2.8 Database connection

- Keep one connection. `node:sqlite` `DatabaseSync` is synchronous (`NodeSqliteClient.ts:8`, `:330`), so more connections on the same thread cannot overlap. Every query must be bounded: indexed lookups and `LIMIT 50` pages only. Each query's duration is logged. Target: every query under 50 ms on a valid Production copy (reason: below one frame of perceived lag for the UI). A query over the target is fixed at its cause (index, scan, shape). No extra connections, worker threads or caches.

### 2.9 Startup, logging, diagnostics

- The app never refuses to start. The migration runs inside one transaction (3.2). On failure the transaction rolls back and the database is unchanged. The app then starts and shows the banner "Penkra could not upgrade your data: <error>. Your data is unchanged; contact support." It refuses new sends and shows every existing chat read-only from the old tables. If the current step 4 code does anything else, report it.
- Logs: server and desktop write plain-text lines to `~/Penkra/.penkra/userdata/logs/server.log` and `desktop.log` (append; one file per process; rotation at app start when a file exceeds 50 MB, keeping one previous file — reason: bound disk use without a timer). A logging failure is ignored.
- Delete the diagnostics machinery outright: `packages/shared/src/diagnostics/store.ts` (`DiagnosticsStore`, `DiagnosticsSpoolWriter`, the cross-process `.lifecycle-lock` under `userdata/diagnostics`, the health sampler, the process watchdog, expectations, spool import), `apps/desktop/src/diagnosticsWorker.ts`, `desktopDiagnosticsQueue.ts`, `desktopDiagnosticsMonitors.ts`, `apps/server/src/diagnostics/recorder.ts`, the `penkra diagnostics threads *` operations and their help, and `diagnostics.sqlite` (deleted from disk at startup). Nothing replaces them except the log files.
- Not affected: `apps/server/src/persistence/DatabaseLifecycleLock.ts` (the database lock used by migration and backup) is a different lock and stays.

### 2.10 Provider credentials

- Read an API key only when a provider process is launched, and pass it into that process's environment. Today `ProviderService.resolveRoutableSession` calls `resolveManagedLaunch` on every `sendTurn`, even for a live session, only to compare an isolation key. Delete that per-send check. An account switch (2.2, `threads.connection_id`) restarts the process, which reads the key then.
- The credential pipe request (`providerCredentialBroker.ts`) has no timer: it resolves on the desktop's answer and rejects when the socket closes or errors. Delete `TIMEOUT_MS` (it came in the 0.10.0 squash `47ff2f5a7` with no reason).
- Measure first, in a dev build after step 10: time each `providers.credentials.*` request on the server and on the desktop and write the numbers in the commit. If any request takes over 50 ms on the desktop side, report it with a CPU profile of the desktop main thread before changing anything.

### 2.11 Agent-facing text

- In scope: the host prompt (the `penkra` MCP server instructions), `penkra --help`, every operation's `--help`, and `SERVER.md`. Every statement must be true for the code as built; every result must say what it means and what the caller does next (as in the 2.4 table); nothing may be said twice in different words; no mention of removed features (approvals, subagents, diagnostics, turn ids for interrupt, receipts).
- Done after steps 10-11, so the text describes final behavior. Deliver as one commit whose message lists each changed text; the reviewer reviews it before the release.
- Removed 2026-10-10 (operator): the workspace `~/Penkra/00000000-0000-4000-8000-000000000000/CLAUDE.md` (dated Jul 23) described commands that no current code has (`penkra whoami`, `penkra todo`, `penkra skill load`, `penkra instructions update`, `core.client.instructions`). No code writes or reads it. It and the empty `client.md` were moved to the Trash.

### 2.12 Right-panel App tabs

Shared state (operator, 2026-10-09):
- New column `projection_folders.app_tabs TEXT NOT NULL DEFAULT '{"open":false,"panes":[],"activePaneId":null}'` holding `{ open, panes: [{ id, kind: "app", appId, appSpaceId, appSlug, appName, appRoute }], activePaneId }`. Runtime-only fields (`appIconDataUrl`, `appPresentationTitle`, `appPresentationIconUrl`, `appRendererId`, `appDocumentUrl`, `appState`, `appStatus`) are never stored.
- Every change (open, close, select, reorder, show/hide the panel) is one server write followed by a broadcast; every window showing the folder applies it. Dock width stays per window, in memory.
- Delete the localStorage persistence in `apps/web/src/rightDockStore.ts` (keys `penkra:app-tabs-by-deck:v3`, `:v2`, `penkra:app-tabs-by-thread:v1`) and its legacy migration. Old localStorage tabs are not imported; every folder starts with an empty panel once.
Which tab an agent open uses (operator, 2026-10-11; replaces the 2026-10-09 "reuse the folder's existing tab for the same App" rule, which replaced a file the person was reading). Penkra decides the tab; an App never does:
- **No `--tab-id`: always a new App tab** in the thread's folder. This applies to `penkra open` (`--url`, `--path`) and to every App open op (Explorer `resources open`, Browser `tab open`, any other). Delete the implicit reuse: `presentExisting` in `openPenkraResource` (`apps/desktop/src/main.ts`) and the "current or first same-App tab" choice in `apps/desktop/src/appLocalResourceOpener.ts`. The broker passes no `tabId`, so the App's open handler gets no `context.tab`.
- **`--tab-id <id>`: that exact tab.** `penkra open` and every App op accept `--tab-id` (the id from `tabs list`). The broker (`apps/desktop/src/appOperationBroker.ts`) resolves it in the thread's folder and invokes the App's op with that tab as `context.tab` (the SDK already carries `tabId` / `OperationContext.tab`, `packages/sdk/src/operations.ts`; no SDK change). The App navigates that tab; it creates none. An id that names no open tab in the folder (closed, mistyped) fails at once with code `TAB_NOT_FOUND` and the message `Tab "<id>" is not open in folder "<folder title>". Run tabs list.`; no fallback to a new tab.
- **App handlers:** the open handler of an App uses `context.tab` when present, else `context.tabs.open` followed by its open on the new tab. Explorer `penkra-apps/explorer/operations.js` (already always-new since 0.2.14 sideload) and Browser `operations.js` are changed to this one shape; each op's help says: "Opens in a new tab. Pass --tab-id from `tabs list` to open in that tab instead."
- **Window and focus:** unchanged; the "Agent tab activation" rule below picks the window and never takes the person away from what they are working on.
- Tests: open without `--tab-id` twice → two tabs, the first keeps its location; open with `--tab-id` → same tab count, that tab navigated; closed id → `TAB_NOT_FOUND`; Explorer and Browser each pass the same three cases.

Agent tab activation (operator, 2026-10-10). An agent opens, reuses or presents a tab in its thread's folder. The agent never names a window. Definitions:
- **Showing the folder:** the window is visible, not minimized, its current Space is the folder's Space and its current thread belongs to the tab's folder.
- **Person busy in the right panel** of a window: `PanelFocusState.shouldPreserveAgentOpen(windowId, windowIsFocused)` (`apps/desktop/src/panelFocus.ts`) returns true, i.e. the window is the focused OS window AND the person's last trusted mouse-down or key-down in it landed inside the right panel (dock DOM via the `preload.ts` capture listeners, or any App tab's webContents via `recordPanelInteraction` in `main.ts`). Panel-level, not per tab. Reuse it; do not add a second definition.
- **Home window:** `threadHomeWindow.presentingWindow(threadId, folderId, ...)` (keyed by folder, 2.18).
- **Focus order:** a new main-process list of window ids, most recent first, updated on each `BrowserWindow` `focus` event and on `closed`.

Rule, in order:
1. If the home window is showing the folder and the person is not busy in its right panel, act there.
2. Else, among other windows showing the folder where the person is not busy in the right panel, act in the first one in focus order.
3. Else, for agent **opening**: the open never fails (operator, 2026-10-11). The new tab is added to the folder (`projection_folders.app_tabs`, one server write + broadcast) without changing `activePaneId`, so no window switches what the person sees. If a window shows the folder (the person is busy in its right panel), the tab loads there in the background, in the first such window in focus order; if no window shows the folder, the tab loads when a window next shows it. The result is `{ tabId, visible: false }` and the help says: "The tab is open but not shown because you are working in the right panel (or the folder is not open); it shows when you select it." For agent **activation** and `tabs screenshot` (which need the tab visible): fail at once with code `TAB_FOLDER_NOT_AVAILABLE` and the message `Folder "<folder title>" is not open in any window.` (no window shows it) or `You are working in the right panel of every window showing folder "<folder title>".` (all are busy). The agent reports the message and does not retry.

The same rule applies to agent opening (`appTabOpenedRouting.ts`) and agent activation (`activateAppTabForAgent` in `main.ts`, which today checks only visibility). Main decides and sends the request to exactly one window; the renderer never filters requests (delete the folder/Space check, formerly the deck check, at `SingleChatSurface.tsx:219`). The request resolves when that window reports the tab visible and rejects when it reports it cannot show it; no timer. Tests: one window idle → acts; one window busy → open adds the tab in the background (`visible: false`, active tab unchanged), activation gets the busy message; no window on the folder → open stores the tab, it loads when the folder is shown; two windows, home on another folder and the other on the folder → acts in the other; two windows both busy → open in the background, activation busy message; no window on the folder → activation not-open message. Measure first: whether an App tab that has never been visible can load and navigate; if it cannot, report it before building case 3.

### 2.13 Agent tool results and App tab ops (operator, 2026-10-10)

Large results. Provider limits (Codex report, 2026-10-10, sources in thread agent-0a4afe1ae0f5297feef26e43025c7358): Claude Code 25,000 tokens by default (`MAX_MCP_OUTPUT_TOKENS`) and it saves larger results to a file itself; Codex 10,000 tokens for the listed GPT models (`tool_output_token_limit`), cutting off the excess with no file; OpenCode 2,000 lines or 50 KiB (`tool_output`), saving larger results to a file itself.
- One constant, `INLINE_TOOL_RESULT_BYTES = 10000`, in one module. Penkra passes it to every provider at launch: Claude `MAX_MCP_OUTPUT_TOKENS`, Codex `tool_output_token_limit`, OpenCode `tool_output` max bytes and max lines. A token is at least one UTF-8 byte, so a result of N bytes is at most N tokens and at most N lines. A result under the constant therefore always reaches the model whole.
- Every Penkra and App op result: if its UTF-8 size is at most the constant, return it inline. Otherwise Penkra writes the full result to `~/Penkra/.penkra/userdata/tool-results/<threadId>/<opId>.txt` and returns `{ "resultFile": "<absolute path>", "bytes": <n> }`. The agent reads that file with its own file tools. Providers never spill or truncate, so the Claude project-dir symlink problem no longer matters.
- No `--max-chars`, no automatic pruning. A snapshot is returned whole, inline or as a file.

App tab ops:
- `tabs list` returns per tab only `tabId`, `appId`, `appName`, `title`, `status`, `visible`, plus `url` only when the tab shows a web page. Remove `rendererId`, `agentAddressable`, `iconDataUrl`, `state`, `spaceId`, `folderId`, `threadId` (`appCommandPipeServer.ts:465`).
- Delete `tabs diff`: the op, its help text and its tests.
- `tabs screenshot` captures the tab as the person sees it. Remove the `document` option. It picks its window by the 2.12 rule, with the same failure codes.
- The agent cursor shows only agent input. Drive it from the CDP mouse events Penkra sends (`appTabObserver.ts`, `Input.dispatchMouseEvent`) and delete the trusted `pointermove`/`pointerdown`/`pointerup` listeners in `AGENT_CURSOR_SOURCE` (`appTabAgentSurface.ts`).
- Resize cursor: in `sidebar.tsx`, make the resize cleanup idempotent and also run it on the rail's `lostpointercapture` and on window `blur`. Delete the unused overlay cursor helpers in `panelResize.ts` if they have no caller.
- `--input` errors: when `--input` is not valid JSON, the error says so and shows a quoted example: `--input '{"key":"value"}'`. The parser stays shell-like; it gets no lenient fallback.
- Tests: inline and file result on each side of the constant; `tabs list` fields; screenshot with no `document` option; the cursor ignores a real mouse move; the cursor resets after `lostpointercapture`; the `--input` error text.

### 2.14 Sidebar search palette reads from the server (operator, 2026-10-10)

- Problem (measured in `apps/web/src/components/Sidebar.tsx`, `SidebarSearchPaletteController`): the palette searches only threads whose sidebar page is loaded (pages of 50 per folder), and it matches message text only for threads whose full message history happens to be loaded in the web store. A thread on an unloaded page, or a message in a thread that was never opened, is not found.
- Target: the palette sends the query to the server, and the server searches every non-deleted, non-archived thread in the current Space. Nothing is searched in the browser.
- Server: one clean-core read, `searchThreads({ spaceId, query, limit, cursor })`, in `apps/server/src/cleanCore/threadList.ts`, exposed as one WS RPC.
  - Title match: `threads.title` contains the query, case-insensitive.
  - Message match: the existing trigram FTS table `thread_items_search` (migration 176) over `thread_items.text`.
  - One result per thread: the thread summary row (the existing `THREAD_SUMMARY_COLUMNS`), plus `matchKind` ("title" or "message") and, for a message match, the id and text of the thread's LATEST matching message (highest transcript position). A thread that matches by title is a title result, and no message is attached.
  - Order: title matches before message matches; within each kind, `last_activity_at DESC`, then `id`.
  - Keyset pages of 50, the same page size and cursor style as `listThreads`.
- Web: `SidebarSearchPaletteController` sends the query on each change and shows only the latest response; a stale response for an older query is dropped.
  - Rows that arrive go through `applyThreadRow`, so opening a result needs no second read.
  - The last row loads the next page through the existing `SidebarThreadPageEnd` pattern.
  - A failed read shows the existing toast with title "Could not search threads" and the error message.
- Delete the browser-side thread matching: `matchSidebarSearchThreads` and its scoring, the `messages` field of `SidebarSearchThread`, and the `createAllThreadsSelector` read in the controller. Action, theme and folder matching stay local; they are small fixed lists.
- Tests:
  - Server: a thread on page 2 of its folder is found by title; a message in a never-opened thread is found; an archived thread is not found; the order and the page cursor are as specified.
  - Web: a result absent from the loaded pages is shown and opens; a stale response is dropped.
- Done when `git grep -n "matchSidebarSearchThreads" -- apps` shows no matches.

### 2.15 No fallback re-reads of the shell (operator, 2026-10-10)

- Rule: the web client gets shell state (spaces, folders, threads) from two places only: the startup bootstrap and the live stream. On reconnect, the bootstrap runs again. No code path re-reads the shell to "catch up", "recover" or "reconcile" after a command or an empty state.
- Delete these re-reads:
  - `apps/web/src/components/Sidebar.tsx`: the whole `useEffect` that calls `api.orchestration.getShellSnapshot()` when `threadsHydrated && folders.length === 0` (comment "The sidebar is the visible empty-state owner").
  - `apps/web/src/chatRouteRecovery.ts` and `apps/web/src/chatRouteRecovery.test.ts`: delete both files. In `apps/web/src/components/RestoreOrCreateChatRoute.tsx` and `apps/web/src/routes/_chat.$threadId.tsx`, delete the calls to `refreshEmptyRouteRestoreSnapshot` and `waitForEmptyRouteRestoreFallbackDelay`. After bootstrap, the routes decide from the store as it is. Delete `EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS` from `apps/web/src/chatRouteRestore.ts`.
  - `apps/web/src/components/useSpacesController.ts`, create-Space submit: delete the `getShellSnapshot` call in the `catch` (duplicate-name recovery), so the error is shown as it is. Also delete the `reconciledFromShell` block after a successful create. Keep the local `applyShellEvent({ kind: "space-upserted", ... })` built from the command result, but run it only when the Space is not already in the store.
  - `apps/web/src/lib/shellMutation.ts` and `shellMutation.test.ts`: delete both files. Callers in `apps/web/src/lib/spaces.ts` and `apps/web/src/lib/projectArchive.ts` call `api.orchestration.dispatchCommand(command)` directly.
- Remove the client RPC once nothing calls it: `getShellSnapshot` in `apps/web/src/wsNativeApi.ts`, the `getShellSnapshot` member of `NativeApi.orchestration` in `packages/contracts`, and the `[ORCHESTRATION_WS_METHODS.getShellSnapshot]` handler in `apps/server/src/wsRpc.ts`, together with the method constant. The server-side bootstraps (`wsRpc.ts` around lines 645 and 1157) are not part of this section; they stay under step 4 (c).
- Tests: delete the ChatView.browser.tsx mocks of `getShellSnapshot`, and the test that asserts `getShellSnapshot` is not called. Add a web test: creating a Space whose stream event never arrives still shows the Space, from the command result.
- Done when `git grep -nE "getShellSnapshot|refreshEmptyRouteRestoreSnapshot|EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS|dispatchShellCommand|reconciledFromShell" -- apps/web packages` shows no matches.

### 2.16 No parent threads (operator, 2026-10-10)

- Penkra has no child threads. Remove `threads.parent_thread_id` and every `parentThreadId` field. Subagents are already disabled (2.5).
- Existing rows: old provider-native subagent threads that have a `parent_thread_id` stay as ordinary threads in their folder (every chat is kept). Migration 176 (the step-3 backfill) stays unchanged, because it has already run on dev databases. A new migration 182 counts the rows with `parent_thread_id IS NOT NULL`, runs `ALTER TABLE threads DROP COLUMN parent_thread_id` and logs the count. No index on `threads.parent_thread_id` exists, so none is dropped. Report the number of affected rows in the rehearsal (3.0); it could not be counted on 2026-10-10 while Penkra held the lock.
- Remove:
  - Server: `parent_thread_id` from the INSERT in `apps/server/src/cleanCore/threadStore.ts`; the `AND parent_thread_id IS NULL` conditions (around lines 480 and 490); the loop that collects child threads for deletion (around line 520). From `threadList.ts`, `threadShellSchema.ts`, `threadFixtures.ts` (also delete the helper that sets `parent_thread_id`), and `agentGateway/threadSummary.ts`, remove the field. From `agentGateway/threadReadTools.ts`, remove the `parentThreadId` tool argument, its description and its output field. From `orchestration/Layers/ProjectionSnapshotQuery.ts`, remove the column reads and the `(? IS NULL OR t.parent_thread_id = ?)` filter, and drop `parentThreadId` from `ProjectionThreadShellPageInput`. In `ProviderIntentOutbox.ts` (the ancestor depth walk) and `ProviderCommandReactor.ts` (the `subagent:` prefix), remove the parent logic unless step 12 has already deleted these files.
  - Contracts: `parentThreadId` in `packages/contracts/src/cleanCore.ts` and `orchestration.ts`.
  - Web: delete `apps/web/src/hooks/useLoadThreadAncestors.ts` and `apps/web/src/lib/subagentPresentation.ts`, with their tests and call sites. Remove the parent and child grouping in `Sidebar.logic.ts`, `sidebarThreadRows.ts`, `ChatView.logic.ts`, `ChatView.selectors.ts`, `storeNormalization.ts` and `types.ts`. Every thread is a top-level row.
  - Desktop: rename (not remove) the window-home inheritance parameters. In `apps/desktop/src/appCommandPipeServer.ts`, `main.ts` and `threadHomeWindow.ts`, and in `AgentGateway.ts` / `creationCoordinator.ts` (`onThreadCreated`, `thread.home.inherit`), `parentThreadId` becomes `creatorThreadId`, matching `created_by_thread_id`. The behaviour stays: a thread an agent creates opens in its creator's window.
- Tests: update fixtures; add a migration test in which a thread that had `parent_thread_id` set is listed as a top-level thread in its folder.
- Done when `git grep -nE "parentThreadId|parent_thread_id|subagentPresentation|useLoadThreadAncestors" -- apps packages ':!**/Migrations/**'` shows no matches.

### 2.17 Opening a thread that is not loaded (operator, 2026-10-10)

- Problem (measured in `apps/web/src/routes/_chat.$threadId.tsx`): the route checks only `useStore` `threadShellById` and, when the thread is missing, calls `navigate({ to: "/" })`. The sidebar loads pages of 50 threads per folder, so opening an existing thread that is not on a loaded page (restoring the last route at launch, a thread an agent created, a notification, a link) sends the user to home.
- Target: the route reads `useThreadSummary(threadId)` from `apps/web/src/threadListStore.ts`, not `useStore`.
  - If the row is present, open it.
  - If the row is absent and there is no draft for `threadId` (`useComposerDraftStore` `draftThreadsByThreadId`), call the existing `loadThread(threadId)` once for that `threadId` (one `cleanCore.getThread` read; the server handler `findThread` is one indexed SELECT by id). While the read is in flight, render nothing, as the route does now before hydration.
  - After the read: a row with `archivedAt === null` and `deletedAt === null` opens. If the result is `null`, or the row is archived or deleted, `navigate({ to: "/", replace: true })` as now.
  - If the read fails, show the existing toast with title "Could not open the thread" and the error message, then navigate home.
- No retry, no timer, no second read. Use the same store for `threadFolderId`, `threadArchived` and the thread's folder in this route, so the route has a single source.
- Tests (web): (a) a thread absent from the loaded pages is read once by `getThread` and then rendered; (b) `getThread` returning `null` navigates home; (c) an archived row navigates home; (d) a thread already in the store causes no `getThread` call.
- Done when `git grep -n "createThreadExistsSelector\|threadShellById" -- 'apps/web/src/routes/_chat.$threadId.tsx'` shows no matches.

### 2.18 Folders own their threads: no decks, no working-directory override, required folder (operator, 2026-10-10)

Decisions (operator, 2026-10-10):
- A folder is the deck. Every unarchived thread of a folder is a tab of that folder. Tab order is the folder's sidebar order.
- A thread runs in its folder's directory (`projection_folders.workspace_root`). If the folder has none, the thread runs in its own scratch directory (`ensureDurableThreadWorkspace(threadId, stateDir)` in `apps/server/src/scratchWorkspaces.ts`, as today). No per-thread directory exists.
- Every thread has exactly one folder: `threads.folder_id TEXT NOT NULL REFERENCES projection_folders(folder_id)`.

Measured on the 3.0 copy (`~/penkra-rehearsal/state-copy.sqlite`, 2026-10-10):
- 25 folders; 24 have `workspace_root IS NULL`.
- 581 threads; 0 have `folder_id IS NULL`; 0 point at a missing folder.
- 219 threads set `working_directory` (13 of them unarchived: 4 claudeAgent, 7 codex, 2 opencode). After this change those threads run in their folder's directory or, when it has none, in their scratch directory. This is accepted (clean cut, no compatibility path).
- 28 decks. The largest folder has 66 unarchived threads, so its tab bar shows 66 tabs (operator: "fine").

A. Schema: new migration `183_FolderOwnedThreads.ts`. Migrations 176 and 178 stay unchanged (they have run on dev databases).
1. Rebuild `threads` with the 2.1 definition: no `working_directory`, no `deck_id`, no `deck_sort_order`, and `folder_id TEXT NOT NULL REFERENCES projection_folders(folder_id)`. `PRAGMA foreign_keys = ON` is already set before migrations (`apps/server/src/persistence/Layers/Sqlite.ts:111`), so `DROP TABLE threads` would cascade. Follow the 177 pattern (`177_ThreadHarnessCanonicalForeignKey.ts`):
   - read the definitions of every table, index and trigger that references `threads(id)` from `sqlite_master`;
   - copy those child rows to TEMP tables;
   - drop the child tables;
   - create `threads_new`, then `INSERT INTO threads_new SELECT <the kept columns> FROM threads`;
   - `DROP TABLE threads`, then `ALTER TABLE threads_new RENAME TO threads`;
   - recreate every `threads` index except `idx_threads_deck_order`;
   - recreate the child tables from their stored definitions, reinsert their rows, recreate their indexes and triggers, drop the TEMP tables.
2. `DROP TABLE projection_thread_decks`.
3. In the same migration, before the rebuild, count the rows where `working_directory IS NOT NULL` and the rows where `deck_id IS NOT NULL`. After the rebuild, verify the `threads` row count equals the count before and every child table's row count equals its count before. On a mismatch, fail the migration (the transaction rolls back). Log the counts with `Effect.logInfo`.
4. Test `183_FolderOwnedThreads.test.ts`: a database at migration 182 with threads (one with `working_directory`, one in a deck), items, harness rows, bindings and notices migrates. Row counts are unchanged, the columns are gone, `projection_thread_decks` is gone, and inserting a thread with `folder_id` NULL or an unknown folder fails.
5. Update 2.1 to match (done in this commit).

B. Server: delete the working-directory override.
- `apps/server/src/cleanCore/threadStore.ts`: delete `setThreadWorkingDirectory`; remove `workingDirectory` from the create input and the `INSERT` (line 182, 215).
- `packages/contracts/src/cleanCore.ts`: remove `workingDirectory` from the thread row schemas (lines 138, 239) and delete the `workingDirectory` update action (line 352).
- `apps/server/src/wsRpc.ts`: delete the `case "workingDirectory"` branch (line 1503) and the import.
- `apps/server/src/cleanCore/threadList.ts`, `threadShellSchema.ts`, `threadLifecycle.ts`, `threadFixtures.ts`: remove the field and the fixture action.
- `packages/shared/src/threadEnvironment.ts`: `resolveThreadWorkspaceCwd` takes only `projectCwd`, or is deleted and its callers read the folder's `workspaceRoot` directly. Choose deletion if each caller then reads one value.
- Every place that picks a turn's cwd uses the folder's `workspace_root`, else `ensureDurableThreadWorkspace`:
  - `apps/server/src/cleanCore/ThreadSender.ts:145` and `:199` (read `projection_folders.workspace_root` by the thread's `folder_id` in the same SELECT);
  - `apps/server/src/wsRpc.ts:550`;
  - `ProviderCommandReactor.ts:627`, `:2563`, `:2804`, `:3654`;
  - `agentGateway/presentFile.ts`, `agentGateway/Layers/AgentGateway.ts:569` and `:725`, `agentGateway/creationCoordinator.ts:84` (an agent-created thread runs in its destination folder's directory; delete the `caller.workingDirectory` branch);
  - `appRuntimeCli.ts:712` and `:1044` (relative paths resolve against the caller's thread cwd computed by the same rule);
  - `desktopThreadCommands.ts:161`.
- `packages/contracts/src/orchestration.ts:532`, `:594`, `apps/desktop/src/main.ts:2045`, `apps/desktop/src/desktopAppRuntime.ts:591`, `packages/sdk/src/runtime.ts:189`: remove the `workingDirectory` option.
- Not in scope: `apps/server/src/open.ts`, `codexWorkingDirectory.ts`, `CodexTextGeneration.ts` and `accountAuth.ts` use process working directories, not the thread override. Leave them.

C. Web: delete the folder chip and the directory picker.
- Delete `apps/web/src/components/chat/ProjectPicker.tsx` and `ProjectPicker.test.ts` (recent folders, "Choose from computer…", "Don't work in a folder").
- `apps/web/src/components/ChatView.tsx`: delete `handleResetWorkspaceToHome`, `handleSelectWorkspaceRoot` (lines 6579-6593), `showEmptyLandingProjectPicker`, `emptyLandingProjectChip` and the `DraftFolderBar` block (7352-7395). If `DraftFolderBar` has no other caller, delete it.
- Remove `workingDirectory` from `composerDraftDomain.ts`, `composerDraftPersistence.ts`, `composerDraftActions.ts`, `lib/threadBootstrap.ts` (including the latest-thread inference at lines 53-63), `hooks/useHandleNewThread.ts` (lines 61-69, 187), `storeSelectors.ts`, `storeNormalization.ts`, `storeProjection.ts`, `types.ts`, `sidebarThreadRows.ts`, `Sidebar.tsx`, `SingleChatSurface.tsx`, `routes/-chatThreadRoute.logic.ts`, `lib/threadRename.ts`, `lib/providerModelPrefetch.ts`, `lib/providerDiscovery.ts`, `hooks/useComposerSlashCommands.ts`, `ModelsSettingsPanel.tsx`, `ChatView.logic.ts`, `test/effectRpcWebSocketMock.ts`. Where a value is needed for display or provider discovery, use the folder's `workspaceRoot`.
- Delete the ChatView browser tests for the picker (`ChatView.browser.tsx` around line 7431 and 7468).

D. Decks: delete them; the folder is the tab set.
- Contracts: delete `ThreadDeckId`, `singletonThreadDeckId` (`packages/contracts/src/baseSchemas.ts:34`), `deckId`/`deckSortOrder` on every schema, `CleanCoreListDeckThreads*`, `CleanCoreDeckThreadCursor`, `CleanCoreDeckMovePosition`, the `moveDeckThread` update action, `DesktopThreadDeckPosition`, and the deck IPC channels in `packages/contracts/src/ipc.ts`.
- Server: delete `listDeckThreads` (clean-core and RPC), the `moveDeckThread` branch in `wsRpc.ts`, every `projection_thread_decks` read and write (`threadLifecycle.ts:39-42`, `threadStore.ts:432`, `:548`, `:605`, `:617`, `ProjectionPipeline.ts:341`, `ProjectionSnapshotQuery.ts:1150`), and deck fields in `ProjectionSnapshotQuery.ts`, `projector.ts`, `cleanCore/threadList.ts`. A thread move between folders or Spaces (`moveSidebarItem`, `moveSpace`) changes only `folder_id`/`space_id`/`sidebar_sort_order`.
- `penkra deck` operations (`apps/server/src/appRuntimeCli.ts:396-531`: `current`, `list`, `get`, `create`, `add`, `select`, `reorder`, `leave`, `archive`, `compose`, `send`) and the SDK `deck` API (`packages/sdk/src/runtime.ts:444-456`, `AppThreadDeckPosition`, `operations.ts`, `index.ts`, `tab.ts`) become `penkra folder` operations and an SDK `folder` API on the caller's folder, with the same inputs and results: `current`, `list` (the folder's unarchived threads in sidebar order, paged per 2.8: `LIMIT 50`, input `--cursor <opaque>`, result `{ threads, pageInfo: { nextCursor } }` with `nextCursor` null on the last page, the same shape as `penkra threads read`; help says "Pass pageInfo.nextCursor as --cursor for the next page."), `get`, `create` (a new thread in the folder), `select`, `reorder` (calls `moveSidebarItem`), `archive`, `compose`, `send`. Delete `add` and `leave`: a thread belongs to a folder by `folder_id`, and moving it to another folder happens only in the sidebar. Every help text says "folder" where it said "Thread Deck" or "deck".
- Web tab bar: rename the folder `components/middle-panel/thread-deck-bar/` to `components/middle-panel/folder-tabs/`. `ThreadDeckBar` becomes `FolderTabs`, `DeckTabStripViewport` becomes `FolderTabStripViewport`, `ThreadDeckDnd` becomes `FolderTabsDnd`. Behaviour:
  - tabs = the rows of the active thread's folder from `threadListStore` (the same loaded pages and order the sidebar shows), plus that folder's local drafts, newest draft last;
  - "+" creates a new draft thread in the folder (as the sidebar's new-thread action for that folder);
  - archive button: unchanged (confirm, archive, toast on failure); the archived thread leaves the tabs;
  - drag to reorder calls the existing `moveSidebarItem` update, so the sidebar and the tabs show the same order;
  - delete dragging a sidebar thread into the tab bar (`canAddDraggedThread`, `addThreadToExistingDeck`, `DeckDropPreview`); moving between folders happens only in the sidebar.
- Web: rename `apps/web/src/lib/threadDeckNavigation.ts` (and its test) to `folderTabNavigation.ts` and drop its deck types; delete `singletonThreadDeckId` uses, `deckDrafts`, `getDraftThreadByDeckId`, `canCreateAnotherDeckThread`, `homeDeckId`, `persistedDeckId`, deck fields in `storeProjection.ts`, `storeTestFixtures.ts`, `lib/threadBootstrap.ts`, `hooks/useHandleNewThread.ts`, `composerDraftDomain.ts`, `lib/panelShortcuts.ts`, `routes/_chat.tsx`, `routes/_chat.$threadId.tsx`, `DesktopThreadApiBridge.tsx`, `EventRouter`. Navigation that picked "the nearest visible deck thread" (`findNearestVisibleDeckThread`, `removeDeckThreadPreservingNavigation`) picks the neighbouring tab in the folder.
- Desktop: `threadHomeWindow.ts` keys windows by `threadId` and `folderId` instead of `deckId`; the view record becomes `{ threadId, folderId }`. App tab stores keyed by deck (`appTabViewHost.ts`, `appTabResourceStores.ts`, `appBlobUrlRegistry.ts`, `appScopedFileWriteStore.ts`, `appTransfer.ts`, `appLocalResourceOpener.ts`, `appOperationBroker.ts`, `appCommandPipeServer.ts`, `appTabIpc.ts`, `appTabOpenedRouting.ts`, `panelShortcuts.ts`, `preload.ts`, `main.ts`) are keyed by `folderId`.
- Web right dock: `rightDockStore.ts` / `rightDockStore.logic.ts` key state by `folderId` (`RightDockFolderState`, `dockStateByFolderId`). Delete its localStorage persistence (keys `penkra:app-tabs-by-deck:v3`, `:v2`, `penkra:app-tabs-by-thread:v1`) and its legacy migration now, as 2.12 already requires; until step 10 stores tabs on the server, dock state lives in memory per window.

E. 2.12 and 2.13 now say folder instead of deck (done in this commit): `projection_folders.app_tabs`, "showing the folder", `TAB_FOLDER_NOT_AVAILABLE`, and the `tabs list` field removal names `folderId`.

Tests: every existing deck, picker and working-directory test is deleted or rewritten to the folder rule, never skipped. New tests: (a) a turn in a thread whose folder has `workspace_root` starts with that cwd; (b) a folder without one starts the turn in `ensureDurableThreadWorkspace(threadId, stateDir)`; (c) `FolderTabs` shows the folder's unarchived threads in sidebar order and hides an archived one; (d) a tab reorder issues `moveSidebarItem` and the sidebar order matches; (e) the 183 migration test above.

Done when:
- `git grep -n -i "deck" -- apps packages ':!apps/server/src/persistence/Migrations' ':!apps/desktop/resources'` shows no matches except the historical migration registrations in `apps/server/src/persistence/Migrations.ts` (the imports and `[164, "ThreadDecks", …]` / `[178, "ThreadDeckOrderIndex", …]` entries; a migration's name and file are never renamed) and migration-name assertions in `Migrations.test.ts`;
- `git grep -n "workingDirectory\|working_directory\|setThreadWorkingDirectory\|ProjectPicker\|Don't work in a folder" -- apps packages ':!apps/server/src/persistence/Migrations' ':!apps/server/src/open.ts' ':!apps/server/src/codexWorkingDirectory.ts' ':!apps/server/src/textGeneration' ':!apps/desktop/src/accountAuth.ts'` shows no matches;
- typecheck, lint (0 errors), clean-core, server and web tests pass, and the rehearsal (3) is repeated on a fresh copy of the 3.0 copy with migration 183 included.

### 2.19 Startup loading, folder directory, "+" draft tab (operator, 2026-10-10)

A. Startup loads spaces, folders and running threads only; everything else is read on demand.
- Today `loadOrchestrationSyncSnapshot` (`apps/server/src/wsRpc.ts:645`) and the subscription snapshot (`wsRpc.ts:1152`) call `projectionReadModelQuery.getShellSnapshot()`, which returns every space, folder and thread shell (`OrchestrationShellSnapshot`, `packages/contracts/src/orchestration.ts:621`). The web applies it in `apps/web/src/routes/__root.tsx:949` (`syncServerShellSnapshot`, `reconcilePromotedDraftsFromShellThreads`, `removeOrphanedTerminalsForCurrentState`).
- New snapshot (both call sites): `{ snapshotSequence, spaces, folders, runningThreads }`. `spaces` and `folders` are all unarchived rows, one indexed SELECT each (they are the navigation tree, created by hand; Production has 25 folders). `runningThreads` is the rows with `threads.state = 'running'`, one SELECT on an index on `state`. No other thread is in the snapshot.
- Thread rows for the sidebar and the folder tabs come only from the existing paged list (`LIMIT 50`, cursor, 2.8) into `threadListStore`, when a folder is shown or scrolled. A thread's detail comes only from `getThread` when it is opened (2.17).
- Delete `getShellSnapshot`, `OrchestrationShellSnapshot`'s thread shells and every web consumer that reads all threads from the snapshot. `reconcilePromotedDraftsFromShellThreads` is replaced by the `thread.created` broadcast for that thread id. `removeOrphanedTerminalsForCurrentState` is replaced by removing a thread's terminals when its archive or delete broadcast arrives.
- Tests: the snapshot contains no idle thread; a running thread is in it; opening a folder issues one list page read; the snapshot SQL runs under 50 ms on a fresh rehearsal copy (logged duration).
- Done when: `git grep -n "getShellSnapshot\|OrchestrationShellSnapshot\|reconcilePromotedDraftsFromShellThreads" -- apps packages` shows no matches; typecheck, lint (0 errors), server and web tests pass.

B. A folder can have a directory; its threads start there (2.18 rule unchanged).
- Measured: today only `folder.create` carries `workspaceRoot`, and `decider.ts:378` rejects any non-null value ("Folders are virtual containers…"); `folder.update` (`decider.ts:414`) has no `workspaceRoot`. So no folder can get a directory now; the 1 of 25 Production folders with one is old data.
- Delete the `decider.ts:378` rejection and its message; `folder.create` writes the given `workspaceRoot`. Add `workspaceRoot: optional NullOr(TrimmedNonEmptyString)` to the `folder.update` command and pass it into `folder.updated` (the projector already applies it, `projector.ts:380`).
- UI: the sidebar folder context menu (`Sidebar.tsx`, next to "Edit name" / icon items) gets "Choose directory…" (calls the existing `api.dialogs.pickFolder()`, then `folder.update` with the path; cancel does nothing) and, when the folder has one, "Remove directory" (`folder.update` with `null`).
- A change applies to the next turn of each thread in the folder; a running turn keeps its cwd.
- Tests: create with a directory stores it; update sets and clears it; the next turn after an update starts in the new directory.

C. A "+" draft tab lives only in window memory until its first send.
- "+" creates the draft in the web store only: no server thread row, no `threads.draft` write (2.6 drafts apply to threads that exist). The first send creates the thread with its folder and message in one operation; from then on it is a normal thread and its tab comes from `threadListStore`.
- An unused draft has no close action: it disappears when the window closes or reloads. Pressing "+" while the folder already has an unused draft selects that draft instead of making another (`projectDraftThreadIdByFolderId`).
- Tests: "+" makes no server call; closing the window leaves no thread row; the first send creates exactly one thread; "+" twice yields one draft tab.

## 3. Migration of Production (in place, keep every chat)

0. **Rehearsal copies:** made only with `sqlite3 'file:<Production>?mode=ro' "VACUUM INTO '<dest>'"` (never by copying `state.sqlite`, `-wal`, `-shm` files; that produced a corrupt copy on 2026-10-09 whose counts must not be used). The copy can be made only while Penkra is quit: Penkra opens `state.sqlite` with `PRAGMA locking_mode = EXCLUSIVE` (`apps/server/src/persistence/Layers/Sqlite.ts:82`), so every other process gets "database is locked (5)" for as long as Penkra runs. Measured 2026-10-10: a read-only `SELECT` with `.timeout 10000` still failed. A busy timeout cannot fix this, so do not add one. Before making a copy, ask the operator to quit Penkra. Run the copy and the `integrity_check`, then tell the operator Penkra can be reopened. Every copy must return `ok` from `PRAGMA integrity_check` before use.
1. At startup, holding `DatabaseLifecycleLock`: if free disk space is less than the current `state.sqlite` size, do not migrate; show the banner from 2.9 with "not enough free disk space (need <n> GB)". Otherwise `VACUUM INTO` `state.pre-0.14.4.sqlite` and require `PRAGMA integrity_check` = `ok` on it.
2. In one transaction: create the new tables and fill them (mapping below).
3. In the same transaction, verify: `threads` count = `projection_threads` count; per thread, the number of `user` + `text` items equals the source's user + assistant message count; every open pending interaction is an `open` question. On any mismatch, roll back (2.9 banner names the first mismatch).
4. After commit: drop every table listed as replaced or dropped in 4.1, then `VACUUM`.
5. Keep `state.pre-0.14.4.sqlite` until the operator deletes it.

Mapping:
- `threads` from `projection_threads` + `projection_thread_sessions`: all `state='idle'`; `space_id` from the thread's folder; `provider`/`model`/`model_options` from `model_selection_json`; `connection_id` from `projection_threads.connection_id`, else `thread_runtime_bindings.connection_id`; `provider_session_id` = codex `$.threadId`, claude `$.resume`, opencode `$.openCodeSessionId` from `provider_session_runtime.resume_cursor_json`; `native_state_id` from the `active` row of `provider_native_state_generations`; `created_by` = `agent` when `creation_source='penkra_mcp'`, `provider_native` when `'provider_native'`, else `user`; `created_by_thread_id` = `source_thread_id`; `runtime_mode`, `working_directory`, `deck_id`, `deck_sort_order` (migration 183 then removes these three, 2.18), `sidebar_sort_order`, `last_visited_at`, `last_activity_at`, `last_message_preview`, `last_user_message_at` (from `latest_user_message_at`), `archived_at`, `deleted_at`, `created_at`, `updated_at` copied; `open_question_count` = number of open questions written; `queue='[]'`; `draft=NULL`.
- `thread_items` per thread in time order from messages, activities, operations, notices and pending interactions. Tool rows from activities and operations are grouped under one identity (activities: `data.toolCallId ?? data.toolUseId ?? data.callID ?? data.callId ?? data.item.id`, as `apps/web/src/workLog.ts:1884`; operations: `provider_operation_id`): one item per identity per thread, latest observation wins, the `operations` row wins a same-time tie. Old tool status `inProgress`/running in a migrated thread becomes `interrupted` (every migrated thread is idle).
- Notices: `runtime.warning`, `context-compaction`, `media.presented`, `runtime.error` (text = `payload.message`), `provider.turn.start.failed` (text = `payload.detail`). `reasoning` activities → `reasoning` items. Every other activity kind is dropped. Questions come only from `projection_pending_interactions`.
- Old OpenCode subagent results stored as `<task><task_result>…</task_result></task>` become the plain result text.
- `retained` native-state folders (old deletion records whose folder removal failed) are deleted during the backfill. If one cannot be deleted, the backfill rolls back and the 2.9 banner names the path and the error. No `retained-native-state.txt` file exists.

Rehearsal (part of step 4, repeated in step 11 after the drop is added): on a copy made per 3.0, report before/after counts, duration, final file size and free pages, and test the failure path by injecting an error after the first insert (expected: rollback, database unchanged, banner).

## 4. Steps and status

| step | content | status |
|---|---|---|
| 4 | Schema + backfill (3) | committed (`cb85c5280`, columns `d616dac97`, `53e9f675c`). Done: clean-core `listThreads` + web `threadListStore` (`7af069da7`, `1bca9f78d`); every set-state writer and move on clean-core, old commands deleted (`3e7845416`, `7a81cf508`, `bf71db5dd`); create/rename/archive/delete on clean-core, `/fork` and automatic retention removed, foreign keys moved to `threads` (`dc65ad980`, `e80275005`, `7df1c254f`). fallback shell re-reads deleted (`f956713cd`, 2.15); parent threads removed (`3aa76a2a4`, 2.16); unloaded thread opens (`2f20fc0d6`, 2.17). Rehearsal on the 3.0 copy recorded (`efe3658ec`, addendum (c)); folders own threads, migration 183 (`e40f18009`, 2.18); readers moved to canonical rows (`31aef38a0`). **Open, in this order:** (c) startup snapshot per 2.19 A, in progress; it also replaces every other `getShellSnapshot` caller (`threadReadTools.ts`, `desktopThreadRoute.ts`, `providerUpdateCoordinator.ts`) with bounded reads (2.8), since the 2.19 A done-grep allows no match; then 2.19 B (folder directory) and 2.19 C (memory-only draft tab) as separate commits. |
| 6 | Stream consumer, turn state, queue/steer; delete reconciler (2.3, 2.4) | committed (parts 1-5; send results, interrupt/cancel, queue-head rule, Stopping… in `0a6593d2b`, `67773958a`, `567eca023`, `2f32eec80`, `5de7ba21d`) |
| 7 | Questions, approvals removed, subagents disabled (2.5) | committed (parts 1-5b) |
| 8 | Web client: transcript from items, draft sync, approval UI removed (2.1, 2.6) | in progress (tail-follow `18b0c50da`, `f60c94786`; terminal-pills warning `fd3c33935`). **Open:** composer queue on clean-core, queued-message Edit, delete `QueuedComposerTurn` / `thread.turn.cancel-queued` (2.4). |
| 9 | OpenCode image transform (2.7) | committed (`8ef20ddcb`, `bdf3513be`). The real 25-image run is in the operator check in 6. |
| 10 | Right-panel App tabs (2.12) | |
| 11 | Startup and logging; delete diagnostics (2.9); credentials at launch (2.10) | |
| 12 | Delete the old pipeline and its tables (2.2, 4.1); repeat the rehearsal with the drop | |
| 13 | Release documentation and the Production updater (5) | |
| 14 | Agent-facing text (2.11) | |
| 15 | Agent tool results and App tab ops (2.13) | |

Step 12 details: the codebase should shrink substantially; report lines removed. Removing the legacy pump also removes the `Effect.catchCause`/`logWarning` swallow around the clean-core apply in `ProviderRuntimeIngestion.processRuntimeEvent`: a write failure must surface. Delete these symbols (remove, do not rename): `ApprovalRequestId`, `hasPendingApprovals`, `pendingApprovals`, `pending_approval_count`, `ProviderApprovalDecision`, `respondToRequest`, `thread.approval.respond`. Done when `grep` finds none of them outside `apps/server/src/persistence/Migrations/**`.

### 4.1 Production tables (read-only, 2026-10-09)

- **Replaced by `threads` / `thread_items`:** projection_threads, projection_thread_sessions, projection_thread_messages (+ `_search*`), projection_thread_activities, operations, notices, projection_pending_interactions, projection_turns, projection_turn_provider_bindings.
- **Folded into `threads`, then dropped:** `provider_session_runtime` (→ `provider_session_id`), `thread_runtime_bindings` (→ `connection_id` fallback), `provider_native_state_generations` (`active` row → `native_state_id`).
- **Kept:** the list at the top of 2.1.
- **Dropped, bookkeeping journals** (replaced by the idempotent writes of 2.2):
  - orchestration_events, orchestration_command_receipts, orchestration_event_deliveries, orchestration_consumer_state, projection_state
  - provider_intent_outbox, provider_intent_outbox_cutover, provider_intent_outbox_reconciliations, provider_delivery_reconciliations
  - provider_runtime_events, provider_runtime_event_consumers, provider_runtime_open_turns, provider_runtime_projection_failures, provider_runtime_retention_event_work, provider_runtime_retention_state, provider_runtime_retention_turn_work, provider_runtime_thread_cursors, provider_runtime_diagnostic_episodes
  - restart_turn_recoveries, queued_turn_promotions, retention_active_days, lost_and_found, operational_diagnostics
  - `agent_gateway_creation_admissions` → client-chosen thread id + `ON CONFLICT DO NOTHING`.
  - `provider_thread_switch_operations`, `provider_native_fork_operations` → account switch (same provider only) = copy the active native-state folder to a new folder, update `threads.connection_id` and `native_state_id` in one write, then start the turn.
  - `provider_native_state_deletions` → deleting a thread first deletes its native-state folder, then the row. If the folder cannot be deleted, the delete fails with that error (path and cause) shown to the caller, and the thread row stays. Nothing is logged-and-continued, and no `retained-native-state.txt` file exists (operator, 2026-10-10).
  - `provider_connection_logins`, `provider_connection_operations` → a login in progress lives in memory; if the app quits mid-login, the user starts it again.
  - `provider_auth_circuits` → in memory.
  - `connection_rate_limits` → in memory; the usage panel fetches fresh on launch. Delete `ConnectionUsageFactRepository`.
  - `git_thread_environment_operations`, `project_pull_request_pins` → dead (no code outside migrations/tests).

### 4.2 Investigate (report only, after step 14)

- "Reconnect this account to see usage." comes from `connectionUsageEmptyMessage` (`apps/web/src/lib/providerUsageSnapshot.ts:24`) when the snapshot status is `needs-auth`, reported when no credential is found or the usage endpoint answers 401/403 (`providerUsage/providers/codex.ts:155,179`, `claude.ts:409,497`, `http.ts:60`). The operator sees it appear and clear on a second click. Reproduce it, record the status code and the credential read result, and report the cause. Do not change code for it.

## 5. Release documentation and Production updater (step 13)

First review and report what is wrong or missing in: `docs/release.md`, `docs/release-0.14.3-notes.md`, `docs/npm-package-release.md`, `scripts/penkra-release-verify.mjs`, `scripts/release-smoke.ts`, `scripts/verify-release-source-provenance.ts`, `scripts/write-release-artifact-provenance.ts`, `scripts/update-release-package-versions.ts`, `githubUpdateFeed.ts` and the updater setup in `main.ts`. Then replace them with one `docs/release.md` in which every step is a script or command, and delete what it replaces.

**A. Update Production on this Mac (`scripts/update-production.sh <path-to-new-Penkra.app>`).** Runnable from a Penkra thread, although quitting Penkra ends that thread's turn (operator, 2026-10-10):
1. The script verifies the new app first: `codesign --verify --deep --strict` and `spctl --assess --type execute` must pass; otherwise it exits non-zero and changes nothing.
2. It starts a detached updater with `launchctl submit -l com.penkra.updater -- <updater script> ...` (outside Penkra's process tree, survives Penkra quitting), then returns. The thread reports "Updater started; Penkra will quit and relaunch."
3. The updater asks Penkra to quit (`osascript -e 'quit app "Penkra"'`) and waits for the Penkra process to exit (`wait` on its pid via `lsof -p`/`kill -0` loop driven by process exit, not a sleep).
4. It moves `/Applications/Penkra.app` to `~/Penkra/.penkra/updates/<timestamp>/Penkra.app` (the kept old app) and copies the new app to `/Applications/Penkra.app`. The database copy is made by the app itself at first start (3.1).
5. It launches the new app (`open -a /Applications/Penkra.app`) and checks: the server's local status endpoint answers and reports the new version, and the migration result is `ok` (read from `server.log`). The check ends when the server answers or the app process exits.
6. If any check fails, it quits the new app, moves the kept old app back to `/Applications/Penkra.app`, relaunches it, and records "rolled back: <reason>".
7. Every step is appended to `~/Penkra/.penkra/updates/<timestamp>/update.log`. After relaunch, the operator sends the thread "read the update log"; the thread reads the newest `update.log` and reports.
8. Test the rollback once with a deliberately broken build (one whose server exits at start) and attach the log to the step commit.

**B. Publish** (only when the operator asks): bump the version, tag `v0.14.4`, build, sign, notarize, staple, `spctl --assess` passes, run A on this Mac, then the operator publishes the GitHub release (prerelease first if the channel requires it) and confirms electron-updater sees it.

## 6. Done when

- A valid Production copy (3.0) migrates: thread count equal to the source at copy time; all user and assistant messages present; file size and free pages reported.
- Archive works on every non-running thread, including the ones stuck today.
- A steered message appears where the provider received it.
- Every query is under 50 ms on that copy, from the per-query timing log.
- The dropped tables in 4.1 are gone and no code refers to them.
- Subagents are unavailable in all three providers; OpenCode keeps working after 25 images.
- A failed migration leaves the data unchanged and the app shows the banner (tested by injection).
- Every send returns one of the five results in 2.4, each covered by a test.
- `docs/release.md` is complete and A, including the rollback test, has run once on this Mac with operator approval.
- Upload and tab-activation behavior verified in the packaged build.
