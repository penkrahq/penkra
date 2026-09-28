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
- The reactor now replays the legacy journal only through the migration cutover sequence. New
  intents execute from outbox lanes. An integration test holds one provider turn and proves a
  later unrelated turn reaches its provider while the first remains in flight.
- Startup recovery classifies expired claims, and terminal jobs enter a provider-runtime fence.
  A failed fence leaves the lane blocked and visible through the existing blocker RPC. Operator
  reconciliation has a separate append-only outbox audit and can authorize retry, accepted, or
  fenced-abandon outcomes.
- The drain follows events created by provider processing rather than stopping at its initial
  journal high-water mark.

## Remaining before this branch can be considered complete

The executor cutover is under regression testing. Stop/interrupt still needs a supervised
control path that can preempt a stuck ordinary lane. The binding revision and lifecycle
generation captured in each job are not yet validated before side effects. A recovery sweep
currently checks terminal blockers once per second; it needs bounded retry/backoff and durable
fence evidence. Settled outbox rows need retention pruning. Full crash, stop-race, and migration
upgrade tests are still needed. Do not launch this branch against a persistent app database.

The runtime-event worker, command worker, and socket-admission boundary are separate parts of
the proposed thread-runtime design and remain unchanged on this branch.
