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

Tables kept unchanged: `projection_spaces`, `projection_folders`, `projection_thread_decks` (plus one new column, 2.12), `space_navigation_state`, `auth_sessions`, `auth_pairing_links`, `provider_connections`, `provider_credential_profiles`, `provider_installations`, `managed_attachment_blobs`, `managed_attachment_cleanup_jobs`, `connection_usage_daily`, `connection_usage_turn_events`, `thread_harness_states` (its `thread_id` foreign key moves from `projection_threads` to `threads`, because `projection_threads` is dropped), `effect_sql_migrations`. They are not renamed.

```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY,                  -- chosen by the client (UUID) before the create call
  space_id TEXT NOT NULL,
  folder_id TEXT,
  title TEXT NOT NULL,
  provider TEXT NOT NULL,               -- codex | claudeAgent | opencode
  connection_id TEXT,                   -- NULL = provider's anonymous route
  model TEXT NOT NULL,
  model_options TEXT,                   -- JSON object, provider-specific
  runtime_mode TEXT NOT NULL,           -- copied from projection_threads.runtime_mode
  working_directory TEXT,               -- the thread's cwd; NULL = folder's workspace root
  provider_session_id TEXT,             -- provider-native resume id (3.2)
  native_state_id TEXT,                 -- folder with the provider's own conversation files
  state TEXT NOT NULL,                  -- idle | running | error (2.3)
  active_turn_id TEXT,                  -- provider turn id; set and cleared only by the stream consumer
  last_error TEXT,                      -- set when state becomes 'error'; cleared when a turn starts
  draft TEXT, draft_updated_at TEXT,    -- 2.6
  queue TEXT NOT NULL DEFAULT '[]',     -- 2.4
  created_by TEXT NOT NULL,             -- user | agent | provider_native
  created_by_thread_id TEXT,            -- the agent thread that created it (created_by='agent')
  parent_thread_id TEXT,                -- only on old provider-native subagent threads; never written by new code
  deck_id TEXT, deck_sort_order INTEGER NOT NULL DEFAULT 0,
  sidebar_sort_order INTEGER,
  is_pinned INTEGER NOT NULL DEFAULT 0, -- pinned in the sidebar
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

Old `projection_threads` columns that are NOT carried over, with the reason: `latest_turn_id` (= `active_turn_id`), `fork_source_thread_id` (0 rows use it; the `/fork` slash command is removed, operator 2026-10-10), `subagent_agent_id/nickname/role` (subagents disabled, 2.5), `pending_approval_count` (approvals removed), `pending_user_input_count` (replaced by `open_question_count`), `pinned_messages_json`, `notes` (feature deleted, 2.4), `thread_markers_json` (no code reads it), `source_turn_id`, `gateway_operation_id`, `gateway_operation_index` (replay bookkeeping, 2.2), `work_status` (derived, above), `connection_id_selected` (no client reads it). Old `projection_thread_sessions` columns are replaced by `provider_session_id`, `state`, `active_turn_id`, `last_error`.

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

Editing a queued message: in the composer's queue list, "Edit" removes the message from `threads.queue` and puts its text and attachments into the thread draft, in one write. The composer then shows it once. Test: queue one message, press Edit, assert the queue is empty and the composer contains the text exactly once (operator-reported duplicate bug).

Removed features:
- Editing sent user messages (operator, 2026-10-09): delete `packages/shared/src/conversationEdit.ts`, `resolveTailUserMessageEditTarget` and its ChatView wiring. Stop and resend is the correction path.
- Pinned messages and thread notes (operator, 2026-10-09): delete `pinnedMessages.ts`, `usePinnedMessageActions.ts`, `@penkra/shared/pinnedMessages`, the `PinnedMessage` contracts and pin/notes commands, and the `onTogglePinMessage`/`pinnedMessageIds` wiring. Pinned chats in the sidebar (`threads.is_pinned`) stay.

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
- New column `projection_thread_decks.app_tabs TEXT NOT NULL DEFAULT '{"open":false,"panes":[],"activePaneId":null}'` holding `{ open, panes: [{ id, kind: "app", appId, appSpaceId, appSlug, appName, appRoute }], activePaneId }`. Runtime-only fields (`appIconDataUrl`, `appPresentationTitle`, `appPresentationIconUrl`, `appRendererId`, `appDocumentUrl`, `appState`, `appStatus`) are never stored.
- Every change (open, close, select, reorder, show/hide the panel) is one server write followed by a broadcast; every window showing the deck applies it. Dock width stays per window, in memory.
- Delete the localStorage persistence in `apps/web/src/rightDockStore.ts` (keys `penkra:app-tabs-by-deck:v3`, `:v2`, `penkra:app-tabs-by-thread:v1`) and its legacy migration. Old localStorage tabs are not imported; every deck starts with an empty panel once.
- `penkra open --url` and every other agent open reuse the deck's existing tab for the same App (present it and navigate) instead of creating another (`openPenkraResource` in `apps/desktop/src/main.ts` must pass `presentExisting`).

Agent tab activation (operator, 2026-10-10). An agent opens, reuses or presents a tab in its thread's deck. The agent never names a window. Definitions:
- **Showing the deck:** the window is visible, not minimized, its current Space is the deck's Space and its current deck is the tab's deck.
- **Person busy in the right panel** of a window: `PanelFocusState.shouldPreserveAgentOpen(windowId, windowIsFocused)` (`apps/desktop/src/panelFocus.ts`) returns true, i.e. the window is the focused OS window AND the person's last trusted mouse-down or key-down in it landed inside the right panel (dock DOM via the `preload.ts` capture listeners, or any App tab's webContents via `recordPanelInteraction` in `main.ts`). Panel-level, not per tab. Reuse it; do not add a second definition.
- **Home window:** `threadHomeWindow.presentingWindow(threadId, deckId, ...)`, as today.
- **Focus order:** a new main-process list of window ids, most recent first, updated on each `BrowserWindow` `focus` event and on `closed`.

Rule, in order:
1. If the home window is showing the deck and the person is not busy in its right panel, act there.
2. Else, among other windows showing the deck where the person is not busy in the right panel, act in the first one in focus order.
3. Else, fail at once with code `TAB_DECK_NOT_AVAILABLE` and the message `Deck "<deck title>" is not open in any window.` (no window shows it) or `You are working in the right panel of every window showing deck "<deck title>".` (all are busy). The agent reports the message and does not retry.

The same rule applies to agent opening (`appTabOpenedRouting.ts`) and agent activation (`activateAppTabForAgent` in `main.ts`, which today checks only visibility). Main decides and sends the request to exactly one window; the renderer never filters requests (delete the deck/Space check at `SingleChatSurface.tsx:219`). The request resolves when that window reports the tab visible and rejects when it reports it cannot show it; no timer. Tests: one window idle → acts; one window busy → busy message; two windows, home on another deck and the other on the deck → acts in the other; two windows both busy → busy message; no window on the deck → not-open message.

### 2.13 Agent tool results and App tab ops (operator, 2026-10-10)

Large results. Provider limits (Codex report, 2026-10-10, sources in thread agent-0a4afe1ae0f5297feef26e43025c7358): Claude Code 25,000 tokens by default (`MAX_MCP_OUTPUT_TOKENS`) and it saves larger results to a file itself; Codex 10,000 tokens for the listed GPT models (`tool_output_token_limit`), cutting off the excess with no file; OpenCode 2,000 lines or 50 KiB (`tool_output`), saving larger results to a file itself.
- One constant, `INLINE_TOOL_RESULT_BYTES = 10000`, in one module. Penkra passes it to every provider at launch: Claude `MAX_MCP_OUTPUT_TOKENS`, Codex `tool_output_token_limit`, OpenCode `tool_output` max bytes and max lines. A token is at least one UTF-8 byte, so a result of N bytes is at most N tokens and at most N lines. A result under the constant therefore always reaches the model whole.
- Every Penkra and App op result: if its UTF-8 size is at most the constant, return it inline. Otherwise Penkra writes the full result to `~/Penkra/.penkra/userdata/tool-results/<threadId>/<opId>.txt` and returns `{ "resultFile": "<absolute path>", "bytes": <n> }`. The agent reads that file with its own file tools. Providers never spill or truncate, so the Claude project-dir symlink problem no longer matters.
- No `--max-chars`, no automatic pruning. A snapshot is returned whole, inline or as a file.

App tab ops:
- `tabs list` returns per tab only `tabId`, `appId`, `appName`, `title`, `status`, `visible`, plus `url` only when the tab shows a web page. Remove `rendererId`, `agentAddressable`, `iconDataUrl`, `state`, `spaceId`, `deckId`, `threadId` (`appCommandPipeServer.ts:465`).
- Delete `tabs diff`: the op, its help text and its tests.
- `tabs screenshot` captures the tab as the person sees it. Remove the `document` option. It picks its window by the 2.12 rule, with the same failure codes.
- The agent cursor shows only agent input. Drive it from the CDP mouse events Penkra sends (`appTabObserver.ts`, `Input.dispatchMouseEvent`) and delete the trusted `pointermove`/`pointerdown`/`pointerup` listeners in `AGENT_CURSOR_SOURCE` (`appTabAgentSurface.ts`).
- Resize cursor: in `sidebar.tsx`, make the resize cleanup idempotent and also run it on the rail's `lostpointercapture` and on window `blur`. Delete the unused overlay cursor helpers in `panelResize.ts` if they have no caller.
- `--input` errors: when `--input` is not valid JSON, the error says so and shows a quoted example: `--input '{"key":"value"}'`. The parser stays shell-like; it gets no lenient fallback.
- Tests: inline and file result on each side of the constant; `tabs list` fields; screenshot with no `document` option; the cursor ignores a real mouse move; the cursor resets after `lostpointercapture`; the `--input` error text.

## 3. Migration of Production (in place, keep every chat)

0. **Rehearsal copies:** made only with `sqlite3 'file:<Production>?mode=ro' "VACUUM INTO '<dest>'"` (never by copying `state.sqlite`, `-wal`, `-shm` files; that produced a corrupt copy on 2026-10-09 whose counts must not be used). If it fails with "database is locked", ask the operator to quit Penkra for the copy. Every copy must return `ok` from `PRAGMA integrity_check` before use.
1. At startup, holding `DatabaseLifecycleLock`: if free disk space is less than the current `state.sqlite` size, do not migrate; show the banner from 2.9 with "not enough free disk space (need <n> GB)". Otherwise `VACUUM INTO` `state.pre-0.14.4.sqlite` and require `PRAGMA integrity_check` = `ok` on it.
2. In one transaction: create the new tables and fill them (mapping below).
3. In the same transaction, verify: `threads` count = `projection_threads` count; per thread, the number of `user` + `text` items equals the source's user + assistant message count; every open pending interaction is an `open` question. On any mismatch, roll back (2.9 banner names the first mismatch).
4. After commit: drop every table listed as replaced or dropped in 4.1, then `VACUUM`.
5. Keep `state.pre-0.14.4.sqlite` until the operator deletes it.

Mapping:
- `threads` from `projection_threads` + `projection_thread_sessions`: all `state='idle'`; `space_id` from the thread's folder; `provider`/`model`/`model_options` from `model_selection_json`; `connection_id` from `projection_threads.connection_id`, else `thread_runtime_bindings.connection_id`; `provider_session_id` = codex `$.threadId`, claude `$.resume`, opencode `$.openCodeSessionId` from `provider_session_runtime.resume_cursor_json`; `native_state_id` from the `active` row of `provider_native_state_generations`; `created_by` = `agent` when `creation_source='penkra_mcp'`, `provider_native` when `'provider_native'`, else `user`; `created_by_thread_id` = `source_thread_id`; `runtime_mode`, `working_directory`, `parent_thread_id`, `deck_id`, `deck_sort_order`, `sidebar_sort_order`, `is_pinned`, `last_visited_at`, `last_activity_at`, `last_message_preview`, `last_user_message_at` (from `latest_user_message_at`), `archived_at`, `deleted_at`, `created_at`, `updated_at` copied; `open_question_count` = number of open questions written; `queue='[]'`; `draft=NULL`.
- `thread_items` per thread in time order from messages, activities, operations, notices and pending interactions. Tool rows from activities and operations are grouped under one identity (activities: `data.toolCallId ?? data.toolUseId ?? data.callID ?? data.callId ?? data.item.id`, as `apps/web/src/workLog.ts:1884`; operations: `provider_operation_id`): one item per identity per thread, latest observation wins, the `operations` row wins a same-time tie. Old tool status `inProgress`/running in a migrated thread becomes `interrupted` (every migrated thread is idle).
- Notices: `runtime.warning`, `context-compaction`, `media.presented`, `runtime.error` (text = `payload.message`), `provider.turn.start.failed` (text = `payload.detail`). `reasoning` activities → `reasoning` items. Every other activity kind is dropped. Questions come only from `projection_pending_interactions`.
- Old OpenCode subagent results stored as `<task><task_result>…</task_result></task>` become the plain result text.
- `retained` native-state folders are left on disk; their paths are written to `userdata/retained-native-state.txt`.

Rehearsal (part of step 4, repeated in step 11 after the drop is added): on a copy made per 3.0, report before/after counts, duration, final file size and free pages, and test the failure path by injecting an error after the first insert (expected: rollback, database unchanged, banner).

## 4. Steps and status

| step | content | status |
|---|---|---|
| 4 | Schema + backfill (3) | committed (`cb85c5280`); **open:** the rehearsal ran on a corrupt copy (`docs/clean-0144-notes.md`, Step 4 addendum (b)). Redo it on a copy made per 3.0 and report the numbers before step 11. Add the columns 2.1 lists that `176_CleanCoreSchemaAndBackfill.ts` lacks (`runtime_mode`, `working_directory`, `created_by`, `created_by_thread_id`, `parent_thread_id`, `deck_id`, `deck_sort_order`, `sidebar_sort_order`, `is_pinned`, `last_activity_at`, `last_message_preview`, `last_user_message_at`, `last_visited_at`, `open_question_count`) (done, `d616dac97`, `53e9f675c`). **Open:** move every reader of those fields to `threads` in this step: add one clean-core thread-list read (server query on `threads`, one web store) that the sidebar, deck and `ChatView` read; remove those fields from `ProjectionSnapshotQuery` and from `threadPurge.ts`. Do not point `ProjectionSnapshotQuery` at `threads` as a stopgap. |
| 6 | Stream consumer, turn state, queue/steer; delete reconciler (2.3, 2.4) | committed (parts 1-5); **open:** the send result table, interrupt by message id, queue-head failure rule (2.4), Stop shows "Stopping…" (2.3). |
| 7 | Questions, approvals removed, subagents disabled (2.5) | committed (parts 1-5b) |
| 8 | Web client: transcript from items, draft sync, approval UI removed (2.1, 2.6) | in progress. **Open:** ResizeObserver tail-follow correction (review of `18b0c50da`); expired-terminal-pills warning (2.6); queued-message edit (2.4). |
| 9 | OpenCode image transform (2.7) | committed (`8ef20ddcb`). **Open:** match only `FilePartInput` (`type:"file"`, `mime` starts with `image/`); delete the `mediaType`/`media_type`/`mimeType`/`type:"image"` guesses. The real 25-image run is in the operator check in 6. |
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
  - `provider_native_state_deletions` → deleting a thread deletes its native-state folder right after the row; a failure is logged and the path appended to `userdata/retained-native-state.txt`.
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
