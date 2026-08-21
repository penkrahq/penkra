# Penkra database reliability

This is the contributor and operator contract for Penkra's local SQLite database. It is not part of
the public App API.

## Ownership model

Each production installation and each numbered development slot has one state root, one embedded
backend, and one `state.sqlite`. Numbered Dev slots share source watchers and local web services but
do not share desktop profiles, embedded backends, lifecycle locks, or databases.

The embedded backend owns its database for its complete process lifetime. It first acquires
`state.sqlite.lifecycle-lock`, then opens one SQLite connection, requires SQLite 3.51.3 or newer,
sets `locking_mode=EXCLUSIVE`, enables WAL, and proves the exclusive lock with a transaction before
running migrations or application work. A second Penkra backend targeting the same canonical path
must fail without opening the database.

The lifecycle directory is a Penkra process-ownership guard. Generic SQLite programs do not honor
it. SQLite's own exclusive lock is the second boundary and must remain active until the owning
connection closes.

Do not open and close any additional file descriptor for `state.sqlite` after SQLite acquires that
lock. Traditional POSIX record locks are process-associated: closing a second descriptor for the
same file can release the locks held by the still-live SQLite connection. Permission repair for the
database and pre-existing sidecars therefore happens before the connection opens. A subprocess
regression test—not a second connection in the same process—proves the lifetime boundary.

## Durable state inventory

The following groups own state that is user-visible, required for recovery, or required to prove a
safe collection boundary. Physical names retain the historical `projection_` prefix until the
single cutover migration; that prefix does not mean the rows may be discarded and rebuilt.

| State                               | Owning tables                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Containers and navigation           | `projection_projects`, `projection_spaces`, `projection_threads`, `space_navigation_state`, `project_pull_request_pins`                                                                                                                                                                         |
| Conversation and timeline           | `projection_thread_messages`, `projection_thread_activities`, `operations`, `notices`, `projection_turns`, `projection_thread_sessions`, `projection_pending_interactions`, `projection_thread_proposed_plans`                                                                                  |
| Files and checkpoints               | `checkpoint_diff_blobs`, `managed_attachment_blobs`, `managed_attachment_cleanup_jobs`                                                                                                                                                                                                          |
| Provider ownership and continuation | `provider_session_runtime`, `thread_runtime_bindings`, `provider_native_state_generations`, `provider_native_state_deletions`, `provider_native_fork_operations`, `provider_delivery_reconciliations`, `provider_thread_switch_operations`, `queued_turn_promotions`, `restart_turn_recoveries` |
| Runtime recovery journal            | `provider_runtime_events`, `provider_runtime_open_turns`, `provider_runtime_thread_cursors`, `provider_runtime_projection_failures`                                                                                                                                                             |
| Orchestration delivery and replay   | `orchestration_events`, `orchestration_command_receipts`, `orchestration_consumer_state`, `orchestration_event_deliveries`, `projection_state`                                                                                                                                                  |
| Connections and usage               | `provider_connections`, `provider_connection_logins`, `provider_connection_operations`, `provider_credential_profiles`, `provider_installations`, `connection_rate_limits`, `connection_usage_cursors`, `connection_usage_daily`, `connection_usage_turn_events`                                |
| Product operations                  | `automation_definitions`, `automation_runs`, `automation_scheduler_leases`, `agent_gateway_operations`, `git_handoff_operations`, `operational_diagnostics`                                                                                                                                     |
| Profile deletion accounting         | `profile_stats_deleted_threads`, `profile_stats_deleted_turns`, `profile_stats_deleted_tokens`, `profile_stats_deleted_prompts`, `profile_stats_deleted_skills`                                                                                                                                 |
| Migration proof                     | `effect_sql_migrations`                                                                                                                                                                                                                                                                         |

The principal read paths are intentionally explicit:

- Thread snapshots and archived Thread reads flow through `ProjectionSnapshotQuery` and the
  projection repository layers. Activity pagination orders by durable activity sequence; message
  pagination orders by causal sequence and message identity.
- Diagnostic pagination flows through `ThreadDiagnosticsQuery`; profile totals flow through the
  profile-stats query and its deleted-state accounting tables.
- Checkpoint diff, edit, revert, and rollback decisions read projected turns/messages plus
  `checkpoint_diff_blobs`; they do not depend on settled provider fragments.
- Runtime resume reads `provider_runtime_open_turns`, per-Thread cursors and failures, provider
  session/native ownership, and `restart_turn_recoveries`.
- Explicit projection repair reads the bounded orchestration delivery log and `projection_state`.
  Ordinary empty-snapshot handling does not trigger repair.

Any new collection rule must name which row in this inventory proves that the discarded record is
no longer needed. Provider name and record age are never sufficient evidence.

## Supported operations

While Penkra is running, inspect state through registered Penkra diagnostics or backend APIs. Never
open the database with `sqlite3`, a database browser, an IDE extension, shell Node, Bun, or a custom
script. A connection described as read-only can still participate in WAL recovery and close-time
checkpoint cleanup.

After every Penkra process for the exact state root has stopped, verify with:

```text
penkra-database verify /absolute/path/to/state.sqlite
```

The command uses Penkra's bundled maintenance implementation. It refuses a live lifecycle owner,
requires the safe SQLite baseline, takes SQLite's exclusive lock, runs `integrity_check` and
`foreign_key_check`, and validates Penkra's migration lineage and event/projection invariants.

To attribute storage while the database is offline, run:

```text
penkra-database report /absolute/path/to/state.sqlite
```

The JSON report includes database and WAL bytes, page and freelist totals, migration-backup count
and bytes, per-table row and payload-byte totals, per-table/index `dbstat` bytes when supported by
the bundled SQLite, and orchestration event/receipt counts by class.

To build a compact candidate beside the source database, run:

```text
penkra-database compact /absolute/path/to/state.sqlite /absolute/path/to/state.compact.sqlite
```

This operation also refuses a live owner. It creates the candidate with `VACUUM INTO`, removes only
settled transient event copies and their internal provider receipts, runs physical and foreign-key
checks, and compares canonical table and per-Thread semantic hashes against the source. A failed
candidate is deleted. A successful candidate is **not** selected automatically. To select it while
every Penkra process for the state root remains stopped, run:

```text
penkra-database cutover /absolute/path/to/state.sqlite /absolute/path/to/state.compact.sqlite
```

Cutover revalidates both databases and compares their canonical-table and per-Thread semantic
hashes. It then moves the original database to `state.sqlite.pre-cutover.sqlite`, selects the
candidate at the original path, and verifies the selected file again. If any validation or
selection step fails, the original stays selected (or is restored) and the failed candidate is
discarded. An existing rollback artifact blocks a later cutover so it cannot be overwritten
silently.

Migration snapshots use `VACUUM INTO`. Future online or periodic snapshots must use SQLite's Online
Backup API. A raw copy of a live `state.sqlite` is unsupported because committed pages may still
exist only in `state.sqlite-wal`.

Migration restore remains explicit and offline:

```text
penkra-restore-migration-backup /absolute/path/to/state.sqlite
```

Restore validates both physical SQLite integrity and Penkra semantic integrity before replacing the
database. There is no automatic `.recover` path: physical recovery can silently discard the
authoritative event history while leaving a queryable file.

## Fatal behavior

`SQLITE_IOERR`, `SQLITE_CORRUPT`, and `SQLITE_NOTADB` poison the active connection. The backend emits
the stable `FatalSqliteDatabaseError` marker and exits without further database access. The desktop
recognizes that marker, stops automatic restart attempts, and directs the operator to logs and an
offline verified recovery. An unsupported SQLite runtime is also non-retryable.

## Required QA matrix

Use disposable state roots unless a manual installed-profile check explicitly requires otherwise.
Never induce concurrency against a valued database.

- start and cleanly stop a fresh database;
- restart after committed Thread activity and verify continuity;
- launch two different numbered Dev slots concurrently;
- attempt a duplicate backend against one root and prove lifecycle-lock refusal;
- attempt a second SQLite connection while the backend owns WAL and prove `database is locked`;
- rebuild/restart the embedded backend while a provider turn is active and prove the old PID exits
  before the new owner acquires the lock;
- terminate the backend abruptly, reopen it, and verify WAL recovery;
- take and validate a migration snapshot;
- reject a physically valid database whose projections exist without authoritative events;
- reject a projection sequence ahead of the event log;
- reject SQLite earlier than 3.51.3;
- recognize corruption once and prove the desktop does not enter its normal restart loop;
- run offline verification after the process tests and confirm physical and semantic health.

Manual completion QA must start a fresh Penkra Dev instance, create and continue a Thread, close the
app cleanly, reopen it, and confirm the Thread persists. Database health is verified only after that
instance is fully stopped.

## Rollout gates

Passing local tests and the manual QA matrix does not authorize a version change, release, or
deployment. For each rollout cohort, retain a verified pre-migration snapshot, record the offline
`verify` and `report` results before and after migration, and prove restart acknowledgement, active
turn recovery, explicit-stop persistence, and ordinary Thread continuation on a real upgraded
profile.

Do not widen the cohort or select a compact candidate while any integrity, projection high-water,
runtime-recovery, or notification-state regression remains unexplained. Observe each deployed
cohort for the planned multi-day window and compare database growth, quarantined runtime events,
restart recoveries, and projection failures against its pre-rollout baseline. A quiet local run or
an incomplete observation window is not evidence that this gate passed. Cutover candidates that
fail any gate are discarded; the verified original remains selected.

## SQLite references

- [How SQLite databases become corrupt](https://www.sqlite.org/howtocorrupt.html), especially the
  POSIX `close()` lock-cancellation behavior in section 2.2.
- [SQLite WAL and the WAL-reset bug](https://www.sqlite.org/wal.html), fixed in 3.51.3 and later.
- [SQLite locking mode](https://www.sqlite.org/pragma.html#pragma_locking_mode), including the
  lifetime behavior of `EXCLUSIVE` mode.
- [SQLite online backup API](https://www.sqlite.org/backup.html) for future live snapshot work.
