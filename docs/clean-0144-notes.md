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

## Addendum (e): native-folder rehearsal stopped on migration failure (2026-10-11)

This attempted rehearsal used the same valid, immutable `state-copy.sqlite`
source as addendum (d). A fresh `run-6.sqlite` was made with the authorized
read-only `VACUUM INTO` command; its initial `PRAGMA integrity_check` returned
`ok`. The real server migration runner through 187 was called inside the
native-folder backfill transaction. No SQL migrations were hand-applied.

Nine existing Claude conversation folders were copied into a disposable state
directory, preserving symlinks and timestamps. Five used account-scoped project
revisions. These folders totalled approximately 7.7 GiB. Their filesystem source
was the current native-state directory, not an atomic snapshot taken alongside
the historical database copy. Each source was hashed before and immediately
after copying, and each disposable copy matched those hashes. Production files
were neither moved nor modified.

The migration action failed after **167,125.753584 ms**. The whole harness ran
for **480.45 seconds**. The propagated error was:

```text
Error: Failed to execute statement
  at apps/server/src/persistence/NodeSqliteClient.ts:121
  cause: Error: cannot rollback - no transaction is active
```

No completed migration was logged. The original statement failure is not
identified by this propagated error. Available disk space was measured at
6.1 GiB during the run; that observation alone does not establish its cause.

After failure, the copy retained **581** source threads, **86,052** source
user/assistant messages, **zero** open pending interactions and **75** source
parent relationships. Canonical `threads` and `thread_items` remained absent,
and the migration tracker was unchanged. Size remained **8,289,067,008 bytes**;
`page_count` was **2,023,698** and `freelist_count` was **0**. Final integrity
was **ok** and `foreign_key_check` returned no rows. All nine disposable native
folders retained their original paths and file hashes. No byte-for-byte database
hash was collected for this success-mode attempt, so unchanged counts are not
claimed as proof of byte identity.

The first failed check was reported and the rehearsal stopped, as required.
No success counts, migration-182 completion count or injected-failure result are
claimed for this attempt. It does not supersede addendum (d)'s successful
183-only rehearsal. The native-folder code remains uncommitted pending review.
No second run or workaround was attempted. The disposable database and native
folder tree, and the temporary repository harness, were removed.

Audit evidence is outside the repository in
`/Users/emmanuelgyekyeatta-penkra/penkra-rehearsal/`:

- `result-native-187-success.json`: failed outcome, before/after counts, tracker,
  native-folder hashes, duration and integrity results.
- `run-6-native.log`: full harness result and exact error.
- `MigrationRehearsal.native-187.local.test.ts`: preserved harness; regular-file
  hashing was changed to an equivalent streaming SHA-256 implementation after
  this run started, for a future run only.

## Addendum (f): native-folder rehearsal and disk cleanup (2026-10-11)

This successful rerun supersedes addendum (e)'s stopped native-folder attempt.
Addendum (b)'s corrupt-copy numbers remain superseded by the valid-copy rehearsals.
The immutable `state-copy.sqlite` (8,331,603,968 bytes) was opened read-only for
`VACUUM INTO` to a fresh `run-7.sqlite`. The resulting starting database was
8,289,067,008 bytes, with integrity `ok`. The real migration runner executed
176 through 187 inside the native-folder backfill transaction.

| Check                                            |          Before |               After |
| ------------------------------------------------ | --------------: | ------------------: |
| Source projection threads / canonical threads    |             581 |                 581 |
| Source user+assistant messages / user+text items |          86,052 |              86,052 |
| Open pending interactions / open question items  |               0 |                   0 |
| Total canonical items                            |          absent |             634,498 |
| Parent links removed (migration 182 log)         |              75 |          75 removed |
| Claude native folders moved                      | 9 staged copies | 9 canonical folders |

All per-thread message counts matched; mismatch list was empty. All nine native
folder file hashes matched after moving; five folders used account-scoped project
revisions. The originals in Production were read and copied, never moved or
modified. These filesystem copies came from current native files, not from an
atomic filesystem snapshot contemporaneous with the retained database.

The whole migration/backfill action took **385,155.252333 ms**. The complete
harness, including copies and post-run validation, took **675.72 seconds**.
Final database size was **11,343,409,152 bytes**; `page_count` was **2,769,387**
and `freelist_count` **587**. Final integrity was `ok`; `foreign_key_check`
returned no rows. This run injected no failure. The injected rollback evidence
in addendum (d) and the native-backfill rollback unit tests are separate checks;
they are not claimed as a new injected-failure rehearsal through 187.

Disk was measured before cleanup at **20,759,695,360 bytes free**. The first
cleanup raised that to **30,215,024,640 bytes**, exceeding the precondition
**24,837,019,109 bytes** (twice the retained database plus native-file copies).
71 disposable/cache directories were removed, with **22,640,033,792 bytes**
of measured allocated data: npm `_cacache` and generated Build, CompilationCache,
Index, ModuleCache and SDKStatCaches children in 14 stale temporary Xcode
DerivedData roots. `xcrun simctl delete unavailable` completed successfully.
SourcePackages, logs, source trees, dependencies, Production data and applications
were preserved. After saving the run's results and deleting its disposable
database and native tree, free space was **41,235,800,064 bytes**.

The requested extra-space breakdown uses the fresh starting `run-7.sqlite`
size (8,289,067,008 bytes) as 1×. These are observed maxima, not a continuously
sampled guarantee of the absolute peak. The copy row means the disposable
rehearsal copy in addition to the retained source; this harness created no
Production pre-upgrade backup (that startup work is assigned to step 11).

| Extra data                                           |          Bytes | Multiple of starting database |
| ---------------------------------------------------- | -------------: | ----------------------------: |
| Fresh rehearsal database copy                        |  8,289,067,008 |                     1.000000× |
| WAL                                                  |              0 |                     0.000000× |
| SQLite TEMP (`etilqs`), highest observed aggregate   | 10,652,899,305 |                     1.285175× |
| Disposable native-folder copies (regular-file bytes) |  8,173,811,173 |                     0.986095× |
| Sum of the four observed category maxima             | 27,115,777,486 |                     3.271270× |

SQLite used a rollback journal rather than WAL in this harness; its highest
observed journal size was 22,016 bytes (0.000003×), outside the WAL row.
Database growth itself was another 3,054,342,144 bytes (0.368478×), outside the
four requested extra categories. TEMP files explained additional disk demand
beyond the precondition estimate. They support a disk-pressure explanation for
run 6 but do not prove its original SQLite error, which had been masked.

Largest `du -sh` observations during the investigation (nested paths overlap,
and measurements span cleanup/copy creation): `~/Library` 246G, `~/Penkra` 152G,
`/tmp` 63G before cleanup, Downloads 60G, Desktop 58G, Penkra_Dev 26G,
CoreSimulator 19G, Xcode 18G, `~/.codex` 18G, rehearsal 16G after copy creation,
`/private/var/folders` 8.8G, Documents 7.7G, Arc cache 7.4G, `.android` 4.9G,
and development 3.8G. Some protected directories were unreadable to `du`.
Worktree dependencies/build outputs and mobile-mock source were not deleted.

Audit evidence remains outside the repository under `~/penkra-rehearsal`:
`result-native-187-run-7.sqlite-success.json`, `run-7-native.log`,
`run-7-integrity.log`, `MigrationRehearsal.native-187-run7.local.test.ts`,
`disk-cleanup-2026-10-11.json`, the disk surveys and space reports, and
`run-7-transient-sql-files.log`. The temporary repository harness and disposable
run database/native tree were removed; the immutable source was preserved.

## Addendum (g): desktop build and native-watcher baseline (2026-10-11)

The desktop production compile succeeds after commit `37335ba8d`:
`bun run build:desktop`, 6 successful / 6 total tasks, 1m15.17s. The React
Compiler contract still verifies all four hot paths. Commit `bea25fd60`
introduced two `(BuildHIR::lowerStatement) Support ThrowStatement inside of
try/catch` bailouts in ChatView; compiling its parent with the actual compiler
reported none. Moving synchronous rejection into a module helper preserves
existing errors, catches and toasts. No packaging, signing or installation
was performed.

The full server suite on `930607429` reported 2,897 passed, 2 failed and
3 skipped tests (740.52s). The failures were the auth credential-release
interleaving and the native recursive workspace watcher. The full web suite
initially reported 2,401 passed and one MessagesTimeline import timeout;
after fixing import setup and deferred storage teardown, all 2,402 tests in
248 files passed with no unhandled errors (93.78s).

The unchanged watcher test was also run in a temporary detached worktree at
`v0.14.3` (`445bc9b8c`), with its own installed dependencies:
`bun run --cwd /tmp/penkra-r143-watcher-baseline/apps/server test src/workspaceWatcher.test.ts`.
It reported 5 passed and 1 failed (5.70s), with exactly the same
`Error: workspace watcher did not publish` at test line 105. Node was
`v24.19.0`. Plain Node probes using `node:fs.watch` independently missed
notifications after creating a root and writing `src/index.ts`, including
recursive and nonrecursive watches, canonical and symlinked roots, and a
repository-local root. These probes used no sleeps or polling. Resolving the
watch path did not make the test pass, so that experiment was reverted.

The operator found that `fseventsd` had been stuck at 100% CPU for 14 days
and restarted it with `sudo killall fseventsd`. The operator reported that
three of three plain-node immediate-write probes then received events.
After that repair, the unchanged HEAD watcher test passed all six tests:
`bun run --cwd apps/server test src/workspaceWatcher.test.ts`, 463ms total
(168ms tests). This was a host-environment failure reproduced at the release
baseline, not a rebuild regression. Watcher code and assertions remain
unchanged. The implementation agent changed no host services or system
settings; the operator performed the restart. The temporary worktree and
this investigation's own probes were cleaned up. Logs:
`/tmp/penkra-r143-watcher-baseline.log`,
`/tmp/penkra-930607429-full-server.log`,
`/tmp/penkra-chatview-compiler-history.log`,
`/tmp/penkra-chatview-build-fixed.log`, and
`/tmp/penkra-chatview-fixed-final-web.log`.

The auth failure exposed an admission interleaving: a new send can become a
`thread.turn-queued` event after a failed predecessor when a queued head
already exists. That handler bypassed the refusal check used by
`thread.turn-start-requested`. Both now use one refusal check. The four
release cases retain their assertions and wait for completed reactor work
before changing the auth circuit. The complete boundary file passes all
13 tests (16.92s). The full web suite passes 2,402 tests in 248 files
(46.34s); root typecheck reports 11 successful tasks (6.871s), and lint
reports 615 warnings and zero errors.

After the host repair and auth fix, the fresh full server suite reports
**2,899 passed, 3 pre-existing skipped, zero failed** tests in 363 passed
files and one skipped file (528.31s), with exit status 0:
`bun run --cwd apps/server test`. Log:
`/tmp/penkra-auth-host-fixed-full-server.log`. No test was removed, weakened,
or newly skipped. The earlier full run which had already recorded the
pre-repair watcher failure was interrupted when the operator fixed the host;
its partial results are not presented as a passing run.

## Final rehearsal after pipeline and provider fold (2026-10-13)

The detached copy job's first run made a consistent 8,958,799,872-byte copy while Penkra was quit. Its integrity check returned `ok`; subsequent accidental relaunches of that job were stopped by the reviewer. G used only fresh `VACUUM INTO` copies of that retained copy, never Production.

The first run exposed 45 historical failed messages in 24 threads being removed by migration 200. de6159be9 corrected this: all historical failed/starting/steering/queued messages remain Failed with no private send payload and never join a retry cohort. The fresh final run passed.

| Evidence                                             | Source |  Final |
| ---------------------------------------------------- | -----: | -----: |
| Threads                                              |    586 |    586 |
| User + assistant/text messages                       | 92,555 | 92,555 |
| Former child thread rows retained through flattening |     79 |     79 |
| Open questions                                       |      0 |      0 |
| Folder rows                                          |     25 |     25 |
| Composer/native-owner discrepancies corrected        |    121 |      0 |

Per-thread message mismatches: 0. Native-state/session/owner mismatches: 0. `foreign_key_check`: empty; no FK targets a dropped table. All nine Claude folders moved; no live thread folder remained at the old path. Every file's tree hash was preserved and all nine exact session-ID JSONL files were present at the canonical path. This proves file/identity preservation, without launching an additional provider turn.

Retained native state: 229 historical rows, 229 existing folders staged by same-volume rename, 0 missing, then 13,068,538,934 logical regular-file bytes removed after commit. On injected failure after the first threads insert, the DB SHA-256 was identical before/after; retained folders were renamed back and the original statement/cause surfaced. No logged-and-continued removal.

Final migration duration: **396,762.52 ms (6.61 min)**. Before VACUUM: 12,115,427,328 bytes, 2,957,868 pages, 2,174,165 free pages. After VACUUM: **3,169,517,568 bytes**, 773,808 pages, **0 free pages**, `integrity_check = ok`. These are migration figures, not a live WAL peak measurement; the rehearsal used the rollback journal.

Evidence is under `~/penkra-rehearsal/run-8/final/result.json` and `run.log`; the initial failed run's report is retained alongside them. At the operator's instruction, closed rehearsal databases, disposable native copies and the retained rehearsal source were deleted after recording the results. Free space afterward: **47,176,974,336 bytes**. No Production database, userdata backup directory or `.corrupt` file was touched.

### Operator-approved post-upgrade cleanup and fixes (2026-10-13)

The local Production upgrade succeeded. The operator subsequently authorized removing the old
backup snapshots and preserved 0.14.3 bundle. The live state.sqlite, WAL/SHM and
state.sqlite.corrupt-20260808T0848Z.sqlite were excluded. Deleted paths and logical sizes:

| Path                                                                                                                                                                                                   |      Bytes |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------: |
| /Users/emmanuelgyekyeatta-penkra/Penkra/.penkra/userdata/state.pre-0.14.4.sqlite                                                                                                                       | 8879104000 |
| /Users/emmanuelgyekyeatta-penkra/Penkra/.penkra/userdata/state.sqlite.backups/.state.sqlite.pre-migration-v161-to-v162-20260910T105155259Z-8d872562-a62b-4c1c-93c4-e2a5be151842.sqlite.partial-journal |       1024 |
| /Users/emmanuelgyekyeatta-penkra/Penkra/.penkra/userdata/state.sqlite.backups/state.sqlite.pre-migration-v175-to-v202-20261013T103828607Z-1b4f0efa-a622-4118-b05a-124aad82ccb5.sqlite                  | 8879104000 |
| /Users/emmanuelgyekyeatta-penkra/Penkra/.penkra/userdata/state.sqlite.backups/state.sqlite.pre-stall-investigation-20260928.sqlite                                                                     | 5635252224 |
| /Users/emmanuelgyekyeatta-penkra/Penkra/.penkra/userdata/state.sqlite.backups/state.sqlite.pre-stall-investigation-20260928.sqlite-shm                                                                 |      32768 |
| /Users/emmanuelgyekyeatta-penkra/Penkra/.penkra/userdata/state.sqlite.backups/state.sqlite.pre-stall-investigation-20260928.sqlite-wal                                                                 |          0 |
| /Users/emmanuelgyekyeatta-penkra/Penkra/.penkra/updates/20261013-043233-825486/Penkra.app                                                                                                              |  445269890 |

The fixed pre-upgrade snapshot and its dated backup were hard links; distinct-inode logical
bytes removed total 14959659906. Free space after removal: 71,556,935,680 bytes.

The finished-turn regression reproduced with stream-only output: the delta bridge and insertion
discarded turn_id, so bounded item reads did not return the turn timing needed by the disclosure.
The writer now preserves the provider turn ID. The branded splash returns to the mark-only
presentation. Folder tab drag previews restore the measured before/after gap and indicator from
0.14.3; canonical moveSidebarItem remains the commit owner. Version stays 0.14.4.

Checks: providerStreamConsumer/providerEventBridge 33 passed (10.68 s); MessagesTimeline
51 passed (3.35 s). Root typecheck 11/11 tasks (20.936 s), and final typecheck 11/11 (6.27 s) after the added render regression. No broad or browser suite requested.

Explorer 0.2.15 was published to the Production registry after operator approval, from the
Explorer-only main commit 9891fa48. Submission 38139da5-39b6-4d9f-bc0a-c5cb13f91ce4
reports published, package digest 6950f865658ac00d24d7253a54314b18dac33f68f894844dbd52e9aa8341837e.
Other Apps and uncommitted source work were excluded from the push.
