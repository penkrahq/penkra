# Provider runtime projection recovery

Provider output is persisted before it is projected into thread messages,
activity, session state, and turn state. The raw runtime journal is evidence;
projection cursors are rebuildable delivery state.

## Invariants

1. A provider event is never skipped or deleted because projection failed.
2. Events remain ordered within a thread.
3. One thread cannot prevent another thread from projecting its events.
4. Projection effects and cursor advancement remain idempotent across retry and
   restart.
5. A thread that cannot safely advance is visibly settled to **Needs
   Attention**, never left indefinitely running.

## Persistence model

- `provider_runtime_events` is the global immutable journal.
- `provider_runtime_thread_cursors` stores the last accepted journal sequence
  independently for every thread.
- `provider_runtime_projection_failures` stores the failing event, stable error
  fingerprint, bounded error detail, attempt count, retry schedule, and
  quarantine lifecycle.
- `provider_runtime_event_consumers` remains only as legacy migration history.
  Migration 90 seeds thread cursors from events already accepted by its global
  cursor.

The next eligible row is the earliest existing journal row above a thread's
cursor. Sequence gaps are valid because idempotent inserts can consume SQLite
autoincrement values.

## Failure handling

The ingestion drain selects at most one pending head per thread and processes
those heads in global journal order. A failure blocks that thread for the
current drain but does not block other selected threads.

The same failure fingerprint is retried with durable exponential backoff and
deterministic jitter. A changing fingerprint resets the deterministic-failure
evidence. A row is quarantined only after both the attempt threshold and the
minimum wall-clock threshold are met.

Quarantine:

- retains the original journal row;
- pauses later rows for only that thread;
- projects an idempotent runtime error into the thread;
- settles a running turn to `error` and stops running UI;
- is restored into the thread projection on startup;
- appears in `penkra_diagnose_thread` with cursor and failure evidence.

`penkra_retry_thread_projection` releases a quarantined row for another attempt.
It does not advance the cursor, delete the event, or bypass ordering. Successful
projection resolves the failure record and advances the thread cursor normally.

## Retention

Accepted history retains the existing bounded diagnostic tail. Open-turn replay
rows remain available until settlement. Quarantined rows are excluded from
retention so repair and replay always have the original event.
