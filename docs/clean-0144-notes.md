# 0.14.4 clean-core — step notes (evidence and decisions)

Companion to `TODO.md` (the approved plan). Factual record only; no planning.

## Step 1 — git

Decision (operator, 2026-10-09): the 8 non-`main` branches were **archived and removed**, not
left in place. The operator checked all 8 (no file changes since Sep 25), committed any
uncommitted work as a WIP snapshot, and tagged each `archive/<branch>`. The 6 scratch/dev
worktrees were removed; the repo-root `penkra` checkout and `penkra-host` are now **detached
HEADs with their folders kept**. Only local branch left is `main`. The operator also repointed
`~/Penkra_Dev/.launcher/workspace.json` `desktopRoot` from the removed
`prod-complete-candidate` to `penkra-worktrees/release-0143`.

State after step 1:

- `main` = `445bc9b8c` (tag `v0.14.3` = `origin/main`).
- `penkra-worktrees/release-0143` is on `main`.
- Cherry-picks: `561a3c356` (browser upload paths), `e8bd5dc0a` (explicit tab activation),
  `842c160b9` (reserve Production migrations 173-175), `25e51d0f2` (this plan).
- Dropped `6ed13bbc8`, `db2e633f8`, `9e2aa7753`, `5396168e1` (absent from `main`, preserved by
  tag `archive/release/0.14.3` = `5396168e1`).
- `archive/prod-complete-candidate` = `594921b8f` (WIP snapshot); its worktree removed.
- 14 `archive/*` tags; 78 branches deleted by me, the remaining 8 archived and removed by the
  operator; only `main` remains.

## Step 2 — inventory check vs plan 4.1

Confirmed against code (`grep -rlw` over `apps/server/src` + `packages`, excluding
`/Migrations/` and `*.test.*`). Every Production table is classified. One correction (operator
confirmed): **`project_pull_request_pins` moves from Kept to Dropped** — it has 0 rows in
Production and zero non-migration code references (only `069_ProjectPullRequestPins.ts` and
`Migrations.test.ts`), like `git_thread_environment_operations`. `TODO.md` 4.1 and this note
were corrected.

Notes for the step-4 drop migration:

- `provider_runtime_retention_state`, `provider_runtime_retention_turn_work`,
  `provider_runtime_retention_event_work` have zero code users in this tree (they were created by
  the candidate's migration 173, which is a reserved no-op here). They exist only on Production,
  so their drop must be `IF EXISTS`.
- Production also has view `thread_activities_read` (depends on `projection_thread_activities`,
  `operations`, `notices`) and FTS shadow tables `projection_thread_messages_search*`. The drop
  order must remove the view before its base tables, and the FTS table drops its shadow tables.

Verified counts (read-only Production, 2026-10-09): 576 `projection_threads`, 42 stuck running
unbound `projection_turns` across 24 threads (14 not deleted), 820,000 `orchestration_command_receipts`,
767,001 `orchestration_events`.

## Step 4 addendum — tool coverage and mapping decisions (2026-10-09)

Operator decisions, written into TODO.md 3/4.1/6 in the same commit as the migration change:

- (a) Old read path: `thread_activities_read` (migration 161) rendered
  `projection_thread_activities` UNION `operations` UNION `notices`, deduping an activity against an
  operation only when `operations.provider_operation_id = json_extract(payload_json,'$.operationId')`
  (that key is absent in the data, so no dedupe). The web grouped rows by
  `data.toolCallId ?? data.toolUseId ?? data.callID ?? data.callId ?? data.item.id`
  (`apps/web/src/workLog.ts:1884`).
- (b) The rehearsal copy used for the coverage counts was **corrupt** (`PRAGMA quick_check`: rowid
  out of order / double page reference) because it was built by copying main+wal+shm from the live
  Production DB; its counts are not trusted and are not relied on. The implementation does not
  depend on overlap: tool rows from **both** sources are grouped under one identity (activities by
  the web identity, operations by `provider_operation_id`), so one item per distinct identity per
  thread and a call present in both sources collapses to one item (latest wins; operations break a
  same-time tie). Unit test covers the overlap case.
- The operator's original key (`$.operationId`) does not exist in the data; my first coverage count
  was wrong and was corrected before implementing.
- (1) notice kinds now also include `runtime.error` (text `payload.message`) and
  `provider.turn.start.failed` (text `payload.detail`); `connection-changed`/`model-changed` dropped.
- (4) model/provider from `model_selection_json`; `thread_runtime_bindings` dropped.
- (5) `space_id` from the thread's folder.
- (6) `provider_session_id` = provider-native resume id (codex `$.threadId`, claude `$.resume`,
  opencode `$.openCodeSessionId`; adapters `CodexAdapter.ts:1904`, `ClaudeAdapter.ts:788,1937`,
  `OpenCodeAdapter.ts:943`).
- (7) done criterion: migrated thread count == source count at migration time.
