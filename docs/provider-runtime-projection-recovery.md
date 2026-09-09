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

## Admission, delivery, and execution are separate facts

A successful command receipt establishes that Penkra accepted the command. A queued turn
establishes retained intent. Neither establishes provider execution. In particular, an interrupt
receipt does not establish that a pending start was cancelled before provider acceptance.

Message delivery records whether the provider accepted the message; the canonical turn records
execution outcome. An accepted message remains history when execution fails. A positively
cancelled, never-accepted start may return to the composer. The exact pending message identity,
canonical turn, and owning runtime generation delimit that transition. Failure before provider
dispatch is distinct from a failure whose delivery outcome is uncertain. A provider turn binding
and an observed execution start are distinct: acceptance must not invent `startedAt`, particularly
when terminal notification precedes the acceptance receipt.

The UI's exact pending-start lookup reads canonical turn identity, exact message delivery, and
projection frontier in one transaction. It returns unknown for ambiguous identity or unavailable
history. Absence from a bounded transcript page is not cancellation evidence. Recovery payloads
are stored per exact message in the existing composer persistence and acknowledged before the
composer is cleared or Send is entered. The renderer registry is an index over those records.
Fresh local owners defer lookup until an admission receipt or uncertain transport result; hydrated
owners revalidate without resubmitting. Unknown outcomes retain their payloads.

Definite cancellation or known-unsent failure restores content and its receipt in one persisted
state change before cleanup. Empty-composer restoration also transfers durable image metadata;
newer composer content is preserved beside a paused recovery row. Rejected writes retain the exact
settlement for retry. Temporary history-row cleanup is independent of payload restoration. A lost
Send response neither restores uncertain input nor deletes a newly promoted Thread.

## State ownership and reconciliation

The runtime is not represented by one authoritative `running` boolean. Each boundary owns a
different fact, and downstream UI state must preserve those distinctions.

| Boundary                   | Owning fact                                                    | Reconciliation rule                                                                                                  |
| -------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Gateway creation admission | Immutable resolved request and caller fingerprint              | Replay the admitted plan and receipt; revalidate current authority without resolving a different account or payload. |
| Queued composer action     | Exact Thread/message action lease                              | Claim before awaiting admission; share ownership across remounts and release only the matching action.               |
| Pending-start recovery     | Exact message delivery, canonical turn and projection frontier | Accepted delivery vetoes restoration; unknown or ambiguous outcome retains recovery ownership.                       |
| Provider startup           | Whether dispatch has actually been entered                     | Only an explicit pre-dispatch failure may settle the owned unaccepted start as definitely failed.                    |
| Runtime lifecycle          | Current session generation and exact provider turn             | Ignore stale-generation lifecycle writes; preserve a different successor when reconciling late results.              |
| Terminal result            | Observed terminal state and completion time                    | Preserve terminal observations across late acceptance; acceptance cannot manufacture an execution start.             |
| Presentation               | Canonical orchestration sequence where available               | Order sequenced records consistently through the final merge; do not invent ordering evidence for legacy records.    |

SQL projection, the in-memory projector, and the web reducer are separate consumers of the same
lifecycle facts. A passing SQL fixture does not establish live renderer parity. In particular, the
web session's normalized `status: connecting` can represent canonical
`orchestrationStatus: starting`; lifecycle handlers use the canonical field and update the visible
session, Thread error, and sidebar summary together. Delivery events containing an explicit
pre-dispatch failure or accepted-terminal outcome therefore carry lifecycle consequences beyond
the message's delivery label.

The cancellation registry holds renderer-memory coordination over durable composer records.
Early-terminal observation uses a process-local observer followed by durable reconciliation.
Controlled journal-checkpoint rehydration establishes the covered restoration boundaries, not
universal multi-process crash atomicity or native desktop acceptance. Generation-bearing session lifecycle and
runtime-error writes additionally carry a server-only expected generation into the orchestration
engine. Its SQL transaction acquires the writer boundary through a conditional runtime-row update
before committing the session event. A mismatch records a state-neutral
`thread.provider-lifecycle-write-skipped` event and an accepted command receipt. Replay recovers
that durable disposition without reconstructing a different command from newer projections.
Skipped exits do not consume cached turn data; explicit historical-turn errors may finalize only
their exact turn history. Generation-bearing turn start, completion and abortion session writes
also compare the captured session status, update timestamp and active turn identity within that
same writer transaction, including an explicitly absent session. The captured fields are ownership
evidence, not a monotonic revision. This additionally rejects a successor overwrite within the
same provider generation. Skipped-write records distinguish generation and session-ownership
mismatches and retain expected/observed ownership where that fence applies. Start and terminal
delivery-policy matching occurs only after applied admission. Legacy events without generation
evidence preserve their existing behavior. This fence does not make renderer memory durable or
establish all multi-process and crash-recovery behaviors.

## Observability boundaries

Runtime-journal sequence and orchestration-event sequence are different ordering domains; they
must not be compared as interchangeable integers. Within-domain journal processing order alone
does not establish the final transcript order after canonical activity, messages, and optimistic
client records are combined.

Diagnostic coverage must name its actual source, high-water mark, pagination, and unknown-order
rows. Reading only the legacy activity projection cannot establish completeness for a UI that
also reads canonical operations and notices. A provider's human-readable usage-limit message is
not evidence of machine-specified retryability, reset time, account scope, or automatic-resume
permission.

Reproduction evidence and current validation limits for these distinctions are recorded in
[the September 2026 lifecycle investigation](thread-lifecycle-evidence-2026-09-07.md).
