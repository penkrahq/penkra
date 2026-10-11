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

## Step 4 addendum (c) — valid-copy rehearsal through migration 182 (2026-10-10)

This addendum supersedes the corrupt-copy coverage numbers identified in addendum
(b). None of those corrupt-copy numbers is used below. The valid source was
`/Users/emmanuelgyekyeatta-penkra/penkra-rehearsal/state-copy.sqlite`, made while
Penkra was quit using the read-only `VACUUM INTO` command recorded in
`/Users/emmanuelgyekyeatta-penkra/penkra-rehearsal/report.md`. The source file was
never opened read-write or modified during this rehearsal. Its final size is still
8,331,603,968 bytes. Production and `/Applications/Penkra.app` were not accessed.

Each disposable database was made with this command (substituting the recorded
run number), and its full `PRAGMA integrity_check` returned exactly `ok` before
use:

```sh
sqlite3 'file:/Users/emmanuelgyekyeatta-penkra/penkra-rehearsal/state-copy.sqlite?mode=ro' "VACUUM INTO '/Users/emmanuelgyekyeatta-penkra/penkra-rehearsal/run-<n>.sqlite'"
```

The working copies were 8,289,067,008 bytes, 2,023,698 pages of 4,096 bytes, with
zero freelist pages. A second `VACUUM INTO` repacked the source (2,034,083 pages);
all logical counts and migration tracker rows matched the source. The harness
called the real `runMigrations()` in `apps/server/src/persistence/Migrations.ts`
with the real `NodeSqliteClient.layer`, foreign keys enabled, and a harness-only
Effect logger. No migration SQL was substituted. The executed migrations were
176, 177, 178, 179, 180, 181 and 182.

### Success run (`run-3.sqlite`)

Command, run from `penkra-worktrees/release-0143`:

```sh
PENKRA_REHEARSAL_MODE=success PENKRA_REHEARSAL_RUN=run-3.sqlite node apps/server/node_modules/.bin/vitest run --root apps/server --maxWorkers=1 --no-file-parallelism src/persistence/MigrationRehearsal.local.test.ts
```

| Check                            |       Before |   After |
| -------------------------------- | -----------: | ------: |
| Source `projection_threads`      |          581 |     581 |
| Canonical `threads`              | Table absent |     581 |
| Source user + assistant messages |       86,052 |  86,052 |
| Canonical user + text items      | Table absent |  86,052 |
| Open pending interactions        |            0 |       0 |
| Open canonical question items    | Table absent |       0 |
| All canonical items              | Table absent | 634,498 |

The per-thread comparison included every source thread and the union of source
and target message thread IDs, treating an absent group as zero. **Mismatches: 0;
thread-ID mismatch list: `[]`.** All per-thread source counts were retained in the
JSON report. The source had 576 confirmed approvals and 183 confirmed user-input
interactions; no pending interaction was open.

Migration 182's actual captured log was:

```text
Removed parent relationships; all chats retained
{"affectedThreads":75}
```

Migration 177 logged zero dropped harness rows, zero dropped runtime-binding rows
and zero dropped notice rows.

- Whole migration runner duration: **449,627.785959 ms** (449.627785959 seconds),
  including client/layer setup and the migration transaction; copy creation and
  before/after validation are excluded.
- Entire success harness: 638.10 seconds.
- Final file size: **11,343,409,152 bytes**.
- `PRAGMA page_count`: **2,769,387**.
- `PRAGMA freelist_count`: **292**.
- Final `PRAGMA integrity_check`: **`ok`**.
- Harness result: `Test Files 1 passed (1); Tests 1 passed (1)`.

This is the additive backfill stage; the legacy table drop and final compaction
have not run. An initial success run (`run-1.sqlite`) had the same data counts,
zero mismatches, final size/page/freelist counts and `ok` integrity. Its migration
duration was 161,962.24925 ms and its entire harness took 254.37 seconds. It was
repeated on a fresh copy solely because its console output did not retain the
migration-182 log; the authoritative logged count above comes from run 3.

### Injected failure run (`run-2.sqlite`)

Command, run from `penkra-worktrees/release-0143`:

```sh
PENKRA_REHEARSAL_MODE=failure PENKRA_REHEARSAL_RUN=run-2.sqlite node apps/server/node_modules/.bin/vitest run --root apps/server --maxWorkers=1 --no-file-parallelism src/persistence/MigrationRehearsal.local.test.ts
```

Only the temporary harness wrapped the native SQLite statement: immediately after
migration 176's first `INSERT OR IGNORE INTO threads` executed, it threw
`Rehearsal injected error after first threads insert`. The real migration runner
returned `MigrationError: Migration "176_CleanCoreSchemaAndBackfill" failed`, with
that injected error in its cause. No injection was added to product code.

- Migration attempt and rollback: **102.38808300000528 ms**.
- Entire failure harness: 368.36 seconds (including both hashes and validation).
- Source and post-rollback counts: **581** projection threads, **86,052** user +
  assistant messages, **0** open pending interactions, **75** parent-linked legacy
  rows. All per-thread message counts and all migration tracker rows matched the
  source. The tracker still ended at 175.
- Canonical `threads` and `thread_items` remained absent after rollback.
- File size before and after: **8,289,067,008 bytes**.
- Page count before and after: **2,023,698**; freelist before and after: **0**.
- Final `PRAGMA integrity_check`: **`ok`**.
- Before and after SHA-256, identical:
  `a5f7dd4592df022f80454f7affc18c357302adc5cd42471a82911356c355f353`.
- Rollback harness result: `Test Files 1 passed (1); Tests 1 passed (1)`.

### Unmet 2.9 banner check and retained evidence

Rollback and all data checks passed. **The complete failure-path requirement did
not pass:** the required banner, “Penkra could not upgrade your data: <error>.
Your data is unchanged; contact support.”, is not implemented in the current
startup path. `apps/server/src/persistence/Layers/Sqlite.ts:141-143` records the
pre-store boot failure and returns `Effect.failCause(cause)`. The migration error
propagated; it was not replaced with the prescribed read-only startup and banner.
`git grep -n 'Penkra could not upgrade your data\|Your data is unchanged; contact support' -- apps packages`
returned no matches. This gap is reported without a product-code workaround;
work on the next item stops here as instructed.

The temporary `MigrationRehearsal.local.test.ts` was removed from the repository
and is not committed. All three disposable SQLite files were deleted after their
numbers were recorded. The source copy and its original `report.md` remain.
Detailed evidence stays outside the repository under
`/Users/emmanuelgyekyeatta-penkra/penkra-rehearsal/`:

- `result-success.json` and `run-3.log`: authoritative success counts, per-thread
  records, migration list and captured log entries.
- `result-success-initial.json` and `run-1.log`: the initial success run.
- `result-failure.json` and `run-2.log`: rollback counts, error cause and hashes.
- `MigrationRehearsal.local.test.ts`: an external audit copy of the removed
  harness, including its injection and logger capture.

### Rehearsal addendum (d): folder-owned threads, migrations 176–183

Run on 2026-10-10 against two fresh disposable copies of the validated,
immutable `~/penkra-rehearsal/state-copy.sqlite`. This is the latest rehearsal;
addendum (c) remains valid for 176–182, and the corrupt-copy numbers in addendum
(b) remain superseded. Neither Production nor the source copy was modified.
Each disposable copy was made with the exact read-only command (using `run-4.sqlite`
for success and `run-5.sqlite` for failure):

```sh
sqlite3 'file:/Users/emmanuelgyekyeatta-penkra/penkra-rehearsal/state-copy.sqlite?mode=ro' "VACUUM INTO '/Users/emmanuelgyekyeatta-penkra/penkra-rehearsal/run-4.sqlite'"
```

Both copies returned `ok` from `PRAGMA integrity_check` before use. Their initial
size was 8,289,067,008 bytes, with 2,023,698 pages and zero freelist pages. Their
logical counts and migration tracker matched the source. The smaller size than
the 8,331,603,968-byte source reflects the fresh `VACUUM INTO` layout.

The success run used `runMigrations()` through 183 via the real server runner,
with foreign keys enabled. Migration duration was **174,104.415417 ms**; the whole
Vitest harness, including validation, took 280.90 seconds.

| Check                            | Before |   After |
| -------------------------------- | -----: | ------: |
| Source `projection_threads`      |    581 |     581 |
| Canonical `threads`              | absent |     581 |
| Source user + assistant messages | 86,052 |  86,052 |
| User + text items                | absent |  86,052 |
| All `thread_items`               | absent | 634,498 |
| Open pending interactions        |      0 |       0 |
| Open question items              | absent |       0 |

Every thread's user + assistant message count matched its user + text item
count: **no mismatches**, including threads with no such messages. The source's
576 approval interactions and 183 user-input interactions were all confirmed.
Migration 177 logged zero dropped harness, binding and notice rows. Migration
182 logged `affectedThreads: 75`. Migration 183's before/after checks preserved
581 threads, 634,498 items, 440 harness rows, 440 runtime bindings and 7,525 notices.
It logged removal of 219 directory overrides and 581 former tab-set memberships.

Final success size: **11,343,409,152 bytes**. `PRAGMA page_count`: **2,769,387**;
`PRAGMA freelist_count`: **592**. Final `PRAGMA integrity_check`: **ok**. This step
retains the legacy tables scheduled for step 12; no extra drop or `VACUUM` was added.

The failure run injected `Rehearsal injected error after first threads insert`
immediately after the first canonical INSERT in migration 176, solely in the
rehearsal harness. The runner returned that cause under
`MigrationError: Migration "176_CleanCoreSchemaAndBackfill" failed`.
Migration duration was **114.266500 ms**; the whole validation harness took
128.81 seconds. Rollback retained exactly 581 source threads, 86,052 source
user/assistant messages, zero open pending interactions and 75 source parent
relationships; canonical tables remained absent and the tracker was unchanged.
Final size remained **8,289,067,008 bytes**, pages **2,023,698**, freelist **0**,
and integrity **ok**. The SHA-256 was identical before and after:

```text
a5f7dd4592df022f80454f7affc18c357302adc5cd42471a82911356c355f353
```

The required 2.9 banner remains absent, as reported in addendum (c). Its startup,
read-only fallback and banner work is assigned to step 11; the reviewer accepted
this as a reported gap rather than a step-4 blocker. No banner, backup/resume,
disk-space or startup workaround was implemented here.

Both disposable databases and the repository's temporary
`MigrationRehearsal.local.test.ts` were deleted after their results were recorded.
The harness is not committed. External audit evidence remains in
`/Users/emmanuelgyekyeatta-penkra/penkra-rehearsal/`:

- `result-183-success.json`, `run-4.log`: exact counts, per-thread comparisons,
  executed migrations, duration, integrity and captured migration logs.
- `result-183-failure.json`, `run-5.log`: rollback counts, injected cause and hashes.
- `MigrationRehearsal.183.local.test.ts`: audit copy of the deleted harness.
