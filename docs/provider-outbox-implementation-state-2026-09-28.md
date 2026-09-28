# Provider outbox implementation state — 2026-09-28

Branch: `fix/thread-runtime-isolation`. This is an incomplete implementation branch and must not
be used as a release candidate or launched against production data.

## Implemented

- Migration 170 records the legacy provider-delivery high-water mark and creates a self-contained
  provider-intent outbox. The new jobs carry a full event snapshot, so event-tail pruning cannot
  remove an unfinished job's input.
- The orchestration command transaction inserts a provider-intent job alongside its event,
  projection, and command receipt. Transaction rollback removes the job and event together.
- Lane keys follow the persisted `parent_thread_id` ancestry for subagents. A native fork with no
  parent owns a separate lane. Each job also snapshots the lane owner's runtime binding revision
  and provider lifecycle generation when present; the executor still needs to validate and fence
  these snapshots before side effects.
- Database claims allow only the first unsettled job in each lane to run. Claims have owner and
  generation checks; an expired unclassified claim can become uncertain instead of replaying
  acceptance-ambiguous work.
- A bounded scheduler can run unrelated lane heads concurrently. A controlled test holds A's
  callback, observes B enter, and confirms A's next job waits until A settles.

## Not yet connected

The old global provider-intent reader remains the active executor. The new scheduler is tested in
isolation but is not started by the reactor. Migration 170's cutover marker is not yet consumed.
Running this branch would therefore accumulate outbox jobs while the old executor continues;
do not launch it against a persistent app database.

Before switching execution, the reactor must drain only pre-cutover legacy events, fence its
owner, then start the outbox worker. It must preserve the old delivery ledger's dead/uncertain
blockers and expose new blockers through the existing reconciliation API. A supervised stop path
must interrupt or fence a busy lane before bypassing its head. Startup must classify expired
claims by replay safety, and shutdown must leave all jobs recoverable. Retention must prune
settled outbox rows without deleting unfinished input. Only after the same A/B production
reproduction and crash/stop matrix pass can the global reader be removed.

The runtime-event worker, command worker, and socket-admission boundary are separate parts of
the proposed thread-runtime design and remain unchanged on this branch.
