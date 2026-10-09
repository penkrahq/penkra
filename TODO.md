# Penkra 0.14.4: clean core

Status: APPROVED by the operator on 2026-10-09 for all steps, 1 through 12. Proceed step by step without waiting between steps. Stop and report only when the evidence contradicts this plan or a decision is not covered by it.

## 0. Rules for whoever implements this

- Work directly on `main`, in `penkra-worktrees/release-0143` (that worktree is switched to `main` in step 1). Do not create worktrees or branches. Mark releases with tags. Never run a bare `git stash`.
- Never write to the Production database (`~/Penkra/.penkra/userdata/state.sqlite`) or `/Applications/Penkra.app`. Read Production only through `file:<path>?mode=ro&immutable=1`. Do not push, publish, install, or tag.
- Clean cuts: no legacy compatibility code, no flags that bring back the old path, no patches on top of the old design. Code that the new design no longer calls gets deleted, together with its tests.
- Process for every step: investigate, then implement exactly as written, then report with evidence (file:line, command output, test results) in the commit message and in the thread. If something here turns out to be wrong or ambiguous, stop and report it. Do not interpret.
- Make one commit per numbered step. Each commit has its tests and passes `bun typecheck`, `bun lint`, and the affected test suites.
- Base: `origin/main` = `v0.14.3` = `445bc9b8c` (verified). `release/0.14.3` is NOT v0.14.3: it lacks the 6 final v0.14.3 commits (`c7099749e` packaged diagnostics asar check, `5de63836d` Windows fsync, `26d3be8ff` diagnostics scan bound, and their merges). Local `main` is 472 commits behind `origin/main`.

## 1. Why (evidence already gathered)

- **Stalls:** `apps/server/src/persistence/NodeSqliteClient.ts` uses one `DatabaseSync` behind `Semaphore.make(1)`, so every read waits behind every write. The snapshot query `listThreadSummaryActivityRowsByThread` (`ProjectionSnapshotQuery.ts`) once held that connection for 1,333,270 ms.
- **Bookkeeping, not chats, fills the database.** Production is 12.4 GB, of which about 4.2 GB are free pages. It holds 576 threads (265 not deleted), 82,805 messages, 1,017,954 activities, 386,587 operations, 767,001 orchestration events, 820,000 command receipts, 47,247 runtime events, and 43,299 outbox rows. Tool activity payloads store input and diff 3 to 4 times.
- **Drift:** turn state is rebuilt from commands, receipts, events, and projections, and then "repaired" by `ProviderRuntimeReconciler.ts` ("Penkra realigned the active provider turn"). Stuck turns block archive: 42 stuck rows across 24 threads, 14 of them not deleted.
- **Ordering:** steering messages jump around because they are placed by `createdAt` (queue time) instead of the order in which they entered the stream.

## 2. Target design

### 2.1 Data model (all of it)

```sql
-- kept as-is, renamed only if trivial: spaces, folders, connections, auth, credentials,
-- installations, usage, attachments blobs, PR pins, navigation, decks, harness states.

CREATE TABLE threads (
  id TEXT PRIMARY KEY,               -- client-chosen
  space_id TEXT NOT NULL, folder_id TEXT,
  title TEXT NOT NULL,
  provider TEXT NOT NULL, connection_id TEXT, model TEXT NOT NULL, model_options TEXT,
  provider_session_id TEXT,          -- resume handle for the provider
  native_state_id TEXT,              -- folder with the provider's own conversation files
  state TEXT NOT NULL,               -- idle | running | error
  active_turn_id TEXT,               -- set from the provider stream only
  last_error TEXT,
  draft TEXT, draft_updated_at TEXT, -- the one composer draft (2.6)
  queue TEXT NOT NULL DEFAULT '[]',  -- pending user messages not yet delivered (2.4)
  archived_at TEXT, deleted_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE thread_items (
  thread_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,       -- position in the transcript; never changes
  source_id  TEXT NOT NULL,          -- client message id, or provider item id
  turn_id    TEXT,
  kind       TEXT NOT NULL,          -- user | text | reasoning | tool | question | notice
  status     TEXT NOT NULL,          -- queued|sent|failed (user); streaming|done (text/reasoning);
                                     -- running|done|error (tool); open|answered|cancelled (question)
  text       TEXT,                   -- what the transcript shows and search indexes
  data       TEXT,                   -- ONE bounded JSON copy of the details (tool input/output, diff, attachments)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq),
  UNIQUE (thread_id, source_id)
);
CREATE VIRTUAL TABLE thread_items_search USING fts5(text, content='thread_items', ...);  -- replaces projection_thread_messages_search
```

- Upsert rule (the only write path for items):
  `INSERT ... VALUES (..., (SELECT COALESCE(MAX(seq),0)+1 FROM thread_items WHERE thread_id=?), ...) ON CONFLICT(thread_id, source_id) DO UPDATE SET status=excluded.status, text=excluded.text, data=excluded.data, updated_at=excluded.updated_at`.
  `seq` is assigned when an item is first seen and never moves afterwards.
- Queued user messages are not items yet. They live in the thread's queue (2.4). When a message is delivered to the provider, it is inserted and gets its `seq` then, so a steered message appears exactly where the agent received it, stamped with that time.
- `data` limit: 64 KB per item. A larger tool output is truncated, with `"truncated": true` and the original byte length recorded. Exactly one copy is kept; there is no `state.input`, `metadata.diff`, or `filediff.patch` duplication.
- Reads: `WHERE thread_id=? AND seq < ? ORDER BY seq DESC LIMIT 50`. The sidebar and summaries read `threads` only. No query scans items across threads.

### 2.2 No receipts, no event journal

- Every action is naturally idempotent:
  - **Create** (thread, message): the app generates a random UUID for the new thing before sending. The server runs `INSERT ... ON CONFLICT(id) DO NOTHING`. A resend after a dropped connection therefore does nothing.
  - **Set state** (archive, unarchive, rename, move, delete, answer a question, stop): a plain `UPDATE` to the target value. Repeating it changes nothing.
- Delete the command/receipt/event/projection pipeline: `OrchestrationEngine`, `OrchestrationReactor`, `ProjectionPipeline`, `projector.ts`, `decider.ts`, the receipts/events/deliveries/consumer tables, `provider_intent_outbox*`, and `providerIntentOutboxWorker.ts`. Each operation becomes a function that validates its input, writes rows in one transaction, and publishes a change notification to connected windows.
- Live updates: an in-memory per-thread publisher. Windows subscribe, receive changed rows, and on reconnect re-read pages from the database. No persisted stream.

### 2.3 Turn state from the provider stream

- Each adapter (Codex, Claude, OpenCode) already emits ordered events per thread. One consumer per thread applies them directly: `turn started` sets `threads.state='running', active_turn_id`; each item event goes through the upsert; `turn ended` (completed/interrupted/error) sets `state='idle'|'error', active_turn_id=NULL`.
- A turn can only be marked finished by an end event from the provider. If the provider process exits, or Penkra quits or crashes mid-turn, that event never arrives; today this is what leaves chats stuck as "running" and unarchivable (the 14 chats). Rule: when a provider process exits, and once at startup, every thread it was running gets `state='idle'` plus a `notice` item "This turn was cut off because the provider stopped." The work is not resumed automatically; send a new message to continue. No reconciler, no "realigned" notice, no restart-recovery tables.
- Archive is allowed unless `threads.state='running'`. Stop sets the state immediately and asks the provider to interrupt.
- Delete: `ProviderRuntimeReconciler`, `restartTurnRecovery.ts`, `startupTurnReconciliation.ts`, `turnLifecycle.ts` (whatever remains unused), and the `provider_runtime_*`, `restart_turn_recoveries`, and `queued_turn_promotions` tables.

### 2.4 Sending, queue, steer

- Each thread has an in-memory FIFO of pending user messages, also stored as `threads.queue` JSON so it survives a restart.
- Send without "now": if idle, deliver; otherwise append to the queue. On turn end, deliver the next message.
- Send with "now": native steer where the provider supports it (Codex, Claude); otherwise interrupt and deliver this message first.
- Delivery inserts the `user` item (2.1).
- No editing of sent user messages (operator decision, 2026-10-09): delete the edit-and-rerun feature (`packages/shared/src/conversationEdit.ts`, `resolveTailUserMessageEditTarget` and its ChatView wiring). Stop + returning the message to the composer is the correction path. Editing a *queued* message stays; after the queue moves server-side, check that it does not duplicate the message in the composer (operator-reported bug).
- No pinned messages and no thread notes (operator decision, 2026-10-09; the side panel is already gone, only the pin toggle on transcript messages remains): delete `pinnedMessages.ts`, `usePinnedMessageActions.ts`, `@penkra/shared/pinnedMessages`, the `PinnedMessage` contracts and pin/notes commands, and the `onTogglePinMessage`/`pinnedMessageIds` wiring through ChatView, ChatTranscriptPane and MessagesTimeline. `projection_threads.pinned_messages_json`/`notes` are not migrated. Not the same as pinned chats in the sidebar (`pinnedThreadsStore`), which stay.

### 2.5 Questions, approvals, subagents

- Questions (Codex `item/tool/requestUserInput`, Claude `AskUserQuestion`, OpenCode `question.asked`) become `kind='question'` items, `status='open'`. Answering updates the same row to `answered` with the answer in `data`. The transcript shows it in place.
- Approvals: removed entirely, both the UI and the code paths. Every provider runs without approval prompts (today's default).
- Subagents disabled: Claude `disallowedTools: ["Task","Agent"]`; OpenCode `tools: { task: false }`; Codex `features.multi_agent=false`. Agents use `penkra threads` instead.

### 2.6 Composer draft

- One draft per thread: `threads.draft`. Each window saves it debounced (300 ms) and broadcasts it; other windows showing that thread update live. The last write wins by `draft_updated_at`. Remove the per-window/local draft storage. The draft also carries the ids of unsent attachments (operator decision, 2026-10-09), so every window shows the same text and attachments; the attachment files stay in the one shared local `composer-drafts-v1/assets/` folder, and a live voice recording stays with the window recording it. Then delete the per-window composer-draft localStorage persistence entirely (not blanked).

### 2.7 Attachments and OpenCode images

- Keep `managedAttachmentStore.ts` as is: files on disk; the provider receives paths.
- OpenCode: an `experimental.chat.messages.transform` that keeps images in the newest user message and replaces older images with the text `[image: <path>]`. No media tables. Browser uploads stay unrestricted.

### 2.8 Database connection

- Keep one connection. `node:sqlite` `DatabaseSync` is synchronous (`NodeSqliteClient.ts:8`, `:330`): every query blocks the server's single JavaScript thread while it runs, so extra connections on the same thread would not let a read run during a write. The stall is fixed by making every query bounded: indexed lookups and `LIMIT 50` pages only, with no query scanning items across threads. Each query's duration is logged, and the target is under 50 ms on the Production copy. Any query over the target is investigated for its root cause (missing index, unbounded scan, wrong data shape) and fixed there. Do not add connections, threads, or caches to hide it.

### 2.9 Startup and diagnostics

- The app never refuses to start. Migration failure: restore the pre-migration copy automatically, start on it, and show a banner with the error. Diagnostics are written to a log file; a diagnostics failure is logged and ignored, never fatal.

## 3. Migration of Production (in place, keep every chat)

1. Under the existing lifecycle lock, copy `state.sqlite` to `state.pre-0.14.4.sqlite` with `VACUUM INTO`, then verify the copy opens and `PRAGMA integrity_check` returns `ok`. If there is not enough free disk space, do not migrate; start the old schema read/write with a banner.
2. In one transaction: create the new tables. Fill `threads` from `projection_threads` + `projection_thread_sessions`, with all `state` = `idle`, `space_id` taken from the thread's folder (Production threads carry a null space; every folder has one), `provider`/`model` from `model_selection_json`, `provider_session_id` = the provider-native id each adapter resumes with (codex `$.threadId`, claude `$.resume`, opencode `$.openCodeSessionId`), and `native_state_id` from the active native-state generation. Fill `thread_items` per thread in time order from messages, activities, operations, notices, and pending interactions, collapsing each tool's activity rows into one item (latest status, one `data` copy). Old OpenCode subagent results stored as `<task><task_result>…</task_result></task>` are written as the plain result text.

   Backfill mapping (from the 2026-10-09 audit; grounded in code + a Production rehearsal):
   - **Tool items are grouped by one identity across both sources.** The old read path (`thread_activities_read`, migration 161) rendered `projection_thread_activities` **and** `operations`; the web grouped rows by its tool-call identity (`apps/web/src/workLog.ts:1884`: `data.toolCallId ?? data.toolUseId ?? data.callID ?? data.callId ?? data.item.id`). Group tool rows from both sources under that identity (operations use `provider_operation_id`), so there is **one item per distinct identity per thread**: a call present in both sources becomes one item (latest observation wins; the canonical `operations` row breaks a same-time tie).
   - **Activity kinds that become `notice`:** `runtime.warning`, `context-compaction`, `media.presented`, `runtime.error` (text = `payload.message`), `provider.turn.start.failed` (text = `payload.detail`); `reasoning` → `reasoning`. Everything else (context window, rate limits, turn/task summaries, reconciliation, `connection-changed`, `model-changed`, `user-input.requested/resolved`, approvals) is bookkeeping and is dropped. Questions come only from the pending-interaction table.

3. Verify: thread count = 576; per thread, user + assistant message count equals the source; every open question is present. On a mismatch, roll back and keep the copy.
4. Drop every replaced table (list in 4.1), then run `VACUUM`.
5. Keep `state.pre-0.14.4.sqlite` until the operator deletes it.

Rehearse on a copy made from the read-only source. Report before/after counts, duration, and final size, and test the restore path by injecting a failure.

## 4. Steps (each one: investigate, report, decide, implement, commit)

1. **Git:**
   - Fast-forward local `main` to `origin/main` (`v0.14.3`).
   - Switch the `release-0143` worktree to `main`.
   - Cherry-pick only `b290d3edd` (browser upload paths), `6323eb759` (explicit tab activation), and `01f55ca36` (registers Production migrations 173-175 so Production opens), plus this `TODO.md`.
   - Drop `6ed13bbc8`, `db2e633f8`, `9e2aa7753`, and `5396168e1`. The new design replaces them, and the migration normalizes old `<task_result>` wrappers into plain text.
   - `prod-complete-candidate` (`fix/prod-complete-candidate-20260929`, 18 commits on top of v0.14.3 plus 455 uncommitted files, almost all in `apps/server/src/persistence`, `provider`, `orchestration`): this is the durable-runtime machinery the rebuild deletes, and the source of Production's migrations 173-175 (already covered by `01f55ca36`). Nothing from it is carried forward. Preserve it: `git add -A` plus one commit "WIP snapshot" on its own branch, tag it `archive/prod-complete-candidate`, then remove that worktree.
   - Delete branches: every local branch except `main`. Tag each one not merged into `main` first as `archive/<branch>` so nothing is lost. Remove every other worktree under `penkra-worktrees/` the same way.
2. **Inventory check:** confirm, against the code, the classification in 4.1. Report any difference before continuing.
3. Bounded queries + per-query timing (2.8).
4. Schema + migration + rehearsal on a copy (3).
5. Write path: item upsert, idempotent operations (2.2), live publisher.
6. Provider stream consumer, turn state, queue/steer (2.3, 2.4). Delete the reconciler and recovery code.
7. Questions in place; remove approvals; disable subagents (2.5).
8. Web client: paged transcript by `seq`, draft sync, removal of approval UI (2.1, 2.6).
9. OpenCode image transform (2.7).
    9b. Right-panel App tabs: one shared state (operator decision, 2026-10-09). Today the open tabs per Thread Deck live in each window's localStorage (`apps/web/src/rightDockStore.ts:84-110`) with no cross-window sync, so closing a tab in one window leaves it open in another. Store the deck's open tabs and active tab on the server with the deck (`projection_thread_decks`, kept in 4.1), push changes to every window, and delete the localStorage persistence; dock width may stay per window. Also: an agent `penkra open --url` always creates a new tab (`apps/desktop/src/main.ts` `openPenkraResource` calls `appTabs.openInstalled` without `presentExisting`), so repeated opens pile up tabs; reuse the deck's existing tab for the same App (present it and navigate) instead.
10. Startup never fatal, diagnostics to file (2.9).
11. Delete the old pipeline and its tables (2.2). The codebase should shrink substantially; report lines removed. Removing the legacy pump also removes the `Effect.catchCause`/`logWarning` swallow around the clean-core apply in `ProviderRuntimeIngestion.processRuntimeEvent` (step 6 part 4): once the clean core is the only transcript writer, a write failure must surface, not be silently logged.

    Also delete the dead approval symbols here (they live in the projection tables this step drops whole, so a migration now would be wasted work): `ApprovalRequestId` (rename to a neutral request id or remove with the legacy contracts), `hasPendingApprovals`, `pendingApprovals`, `pending_approval_count`, `ProviderApprovalDecision`, `respondToRequest`, `thread.approval.respond`. Done-criterion: `grep` finds 0 of them outside historical migrations (`apps/server/src/persistence/Migrations/**`), and the clean-core code imports none of them.

12. Release docs (section 5).

### 4.1 Production tables (from `sqlite_master` and row counts, read-only, 2026-10-09; code users from grep)

- **Replaced by `threads` / `thread_items`:** projection_threads, projection_thread_sessions, projection_thread_messages (+ `_search*`), projection_thread_activities, operations, notices, projection_pending_interactions, projection_turns, projection_turn_provider_bindings.
- **Folded into `threads`:** `provider_session_runtime` (103 rows: `resume_cursor_json`, the provider session to resume) becomes `provider_session_id` = the provider-native id each adapter resumes with (codex `$.threadId`, claude `$.resume`, opencode `$.openCodeSessionId`). `threads.connection_id` comes from `projection_threads.connection_id` (fallback `thread_runtime_bindings.connection_id`); `threads.model` and `threads.provider` come from `model_selection_json` (complete and the user's selection), so **`thread_runtime_bindings` is dropped**, not folded. In `provider_native_state_generations` (639 rows: the per-thread folder holding the provider's own conversation files, used for resume; 435 `active`, 204 `retained` after account switches), the `active` row becomes `threads.native_state_id`. `retained` folders are left on disk untouched; the migration writes their paths to `userdata/retained-native-state.txt`. Deleting them is a separate operator decision.
- **Kept:** projection_spaces, projection_folders, projection_thread_decks, space_navigation_state, auth_sessions, auth_pairing_links, provider_connections, provider_credential_profiles, provider_installations, managed_attachment_blobs, managed_attachment_cleanup_jobs, connection_usage_daily, connection_usage_turn_events, thread_harness_states, effect_sql_migrations.
- **Dropped, bookkeeping journals** (each exists only to make a multi-step operation resumable through the old command pipeline; the replacement is the plain idempotent write in 2.2):
  - orchestration_events, orchestration_command_receipts, orchestration_event_deliveries, orchestration_consumer_state, projection_state
  - provider_intent_outbox, provider_intent_outbox_cutover, provider_intent_outbox_reconciliations, provider_delivery_reconciliations
  - provider_runtime_events, provider_runtime_event_consumers, provider_runtime_open_turns, provider_runtime_projection_failures, provider_runtime_retention_event_work, provider_runtime_retention_state, provider_runtime_retention_turn_work, provider_runtime_thread_cursors, provider_runtime_diagnostic_episodes
  - restart_turn_recoveries, queued_turn_promotions, retention_active_days, lost_and_found, operational_diagnostics (diagnostics go to the log file, 2.9)
  - `agent_gateway_creation_admissions` (222 rows; `AgentGatewayCreationAdmissions.ts`): replay record for `penkra threads create`. Replaced by the client-chosen thread ID + `ON CONFLICT DO NOTHING`.
  - `provider_thread_switch_operations` (287 rows; `ProviderThreadSwitchOperations.ts`, "send-time Connection-switch journal") and `provider_native_fork_operations` (0 rows; used by `ProviderThreadSwitchCoordinator.ts`). Switching account (same provider only) becomes: copy the active native-state folder to a new folder, update `threads.connection_id` and `native_state_id` in one write, then start the turn.
  - `provider_native_state_deletions` (0 rows; crash-safe deletion queue). Deleting a thread removes its native-state folder directly after the row is deleted; a failure is logged and the folder is listed in the same report file.
  - `provider_connection_logins` (17 rows; "SQLite journal for provider-owned Connection login") and `provider_connection_operations` (2 rows; "Connection lifecycle operation journal"). A login in progress is held in memory; if the app quits mid-login, the user starts the login again.
  - `provider_auth_circuits` (0 rows; `providerAuthCircuit.ts`, retry backoff after auth failures): held in memory.
  - `connection_rate_limits` (4 rows; `ConnectionUsageFacts.ts`, read by `providerUsage/index.ts:338`): last usage limits per account. They change constantly, so keep them in memory only; on launch the usage panel fetches fresh. Delete `ConnectionUsageFactRepository`.
  - `git_thread_environment_operations` (0 rows): no code references it (only migrations 068/096/097). Dead table.
  - `project_pull_request_pins` (0 rows): no code outside migration 069 and tests. Dead table.

## 4.2 Investigate (report only, low priority)

- "Reconnect this account to see usage." comes from `connectionUsageEmptyMessage` (`apps/web/src/lib/providerUsageSnapshot.ts:24`) when the snapshot status is `needs-auth`. The server reports `needs-auth` when no credential is found or the usage endpoint answers 401/403 (`providerUsage/providers/codex.ts:155,179`, `claude.ts:409,497`, `http.ts:60`). The operator sees it appear and then clear on a second click. Find out why: reproduce it and capture the status code and the credential read. Report the cause before proposing a fix.

## 5. Release documentation

Review every existing release doc and script: `docs/release.md`, `docs/release-0.14.3-notes.md`, `docs/npm-package-release.md`, `scripts/penkra-release-verify.mjs`, `scripts/release-smoke.ts`, `scripts/verify-release-source-provenance.ts`, `scripts/write-release-artifact-provenance.ts`, `scripts/update-release-package-versions.ts`, and the desktop updater (`githubUpdateFeed.ts`, `main.ts` updater setup). Report what is wrong or missing. Then replace them with one doc, `docs/release.md`, with every step grounded in a script or command:

- **A. Update Production in place:** quit Penkra; copy the database; replace the whole signed and notarized `.app` (never patch the ASAR, because that breaks notarization); launch; check the version, migration result, thread count, and one chat of each provider.
- **B. Publish:** bump the version, tag, build, sign, notarize, staple, `spctl --assess` passes, verify on Production via A, publish the GitHub release (prerelease first if the channel requires it), and confirm electron-updater sees it.

## 6. Done when

- Production copy migrated: thread count after migration == source thread count at migration time (Production is live; it was 576 at planning and 577 by 2026-10-09), all messages present, file size and free pages reported.
- Archive works on every non-running thread, including the 14 currently stuck.
- Steering messages appear where and when they were delivered.
- Every query runs in under 50 ms on the Production copy (measured, from the per-query timing log).
- The tables in 4.1 marked "dropped" are gone, and no code refers to them.
- Subagents are unavailable in all three providers, and OpenCode keeps working after 20+ images.
- The app starts even when migration fails (tested by injecting a failure).
- `docs/release.md` is complete, and one dry run of section A works on a copy.

## Deferred (unchanged)

The installed-app availability note from before: upload and tab-activation changes must be verified in the packaged build once a version is chosen.
