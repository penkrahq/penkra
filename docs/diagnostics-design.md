# Diagnostics design

Status: design for review. The incident-specific timing patch is local and uncommitted; the
end-to-end diagnostic system described here is not built. No release version is selected.

## Goal

The target is for every critical-flow failure in Penkra to leave enough evidence to find its root cause **without reproducing it**. Instrumentation can still fail under process death, a full disk, or an operating-system failure; those gaps must be detectable where another process or a later boot survives.

- If an incident cannot be explained from what was recorded, that is a defect in our tracing (a coverage gap), just as an untested path is a test coverage gap.
- The first fix for a coverage gap is to record what was missing. We do not fix the behaviour until a trace proves the cause.

This follows the operator's rule: "I'd rather we don't solve anything than 'solve' something without a FULL ROOT 100% confident trace."

Builds on:

- [`production-thread-stall-evidence-2026-09-27.md`](production-thread-stall-evidence-2026-09-27.md): measured stall boundaries that current logging could not explain.
- An earlier draft, `production-observability-design-2026-09-27.md`. It is uncommitted in the release worktree, and its content is merged into this document.

## Design inputs and one proposed revision

The prior design selected a full diagnostic reset on every app update. This revision proposes
retaining unresolved incidents across updates because the reset would erase evidence of a failure
that an update was used to recover from. That retention change needs review before implementation.

| Topic                | Decision                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content              | Diagnostics store IDs, states, timings and error codes only. Conversation content already lives in the main database and is joined by ID. No prompt text, model output, tool arguments, credentials, paths or raw URLs.            |
| Disk budget          | 1 GB ceiling for all diagnostics. Normal pruning should keep it far below that.                                                                                                                                                    |
| Pruning on update    | Keep unresolved incidents and their pinned detail across an update, labeled with the build that produced them. Apply ordinary size and age limits; do not erase the evidence needed to diagnose a failure that prompted an update. |
| UI                   | None. Recording is completely silent.                                                                                                                                                                                              |
| Agents               | Diagnostics are readable through the normal `penkra` CLI. Nothing is added to prompts or agent instructions.                                                                                                                       |
| Sending traces to us | Decided later. The design keeps everything local and exportable.                                                                                                                                                                   |
| Deadlines            | We choose defaults and tune them from real incidents.                                                                                                                                                                              |
| QA                   | Scripted automation (Playwright or RPC), not computer use. A run passes only if its scripts pass **and** zero new incidents are recorded.                                                                                          |

## Current state (measured)

- **`server.log` in production is 86 MB since 2026-07-17 (327,926 lines).**
  - It has never been rotated. `apps/server/src/main.ts` uses a file logger with no rotation. The desktop and child logs rotate at 10 MB.
  - About 60% of lines are warnings. One message, "stale orchestration synchronization acknowledgement", makes up 155,108 lines (47%).
- **No end-to-end trace.** There is one `withSpan` in the server, and no trace ID is shared between the renderer, the server and the providers.
- **Failure paths are recorded unevenly.** Examples from the 0.14.1 work:
  - One of the two "caller turn inactive" refusal paths logs nothing.
  - The historical Play rejection did not record which check failed.
  - The 45 s command dispatch timeout (`OrchestrationEngine.ts:88`) records neither which command held the worker nor for how long.
- **Unexplained incidents that this design must be able to explain** (from the stall evidence):
  - **Socket handshakes:** production handshakes took 5–9 s, against the renderer's 3 s attempt deadline (`wsTransport.ts:158`).
  - **Command worker:** the command that held the worker is unknown.
  - **Provider delivery:** one slow provider start blocks provider delivery for every other thread.
  - **Strategy's Claude start:** it hit the 120 s deadline; the slow phase is unknown.
  - **The freeze that needed a machine restart on 2026-09-27:** we cannot tell whether the machine, a provider or Penkra caused it.
- **Existing diagnostics are scattered** across roughly 20 purpose-built modules. Web: chat lifecycle, sidebar, scroll, pagination, composer preflight. Server: `ThreadDiagnosticsQuery`, `providerRuntimeDiagnostic`, `playRejectionDiagnostics`, memory diagnostics. Desktop: update, runtime, crash recovery. These become producers into the single system described below instead of each having its own format.

## Failure inventory

The source-snapshot inventory is in [`diagnostics-failure-inventory.md`](./diagnostics-failure-inventory.md), and its sites are listed in [`diagnostics-failure-sites.md`](./diagnostics-failure-sites.md). It is a read-only scan of `apps/server`, `apps/web` and `apps/desktop` on the earlier design branch, plus a count of the production `server.log`. Its line numbers and counts must be refreshed before enforcement on this branch.

- **5,327 candidate failure or handling sites** in a historical source scan; this count also includes protected `try` blocks and other boundaries that are not separate failures. 446 were locally classified as silent, and 4,923 had no thread, turn, command or connection ID visible in the local statement. Neither number proves the complete call chain is silent or uncorrelated.
- **The largest flows in that snapshot:** apps and extensions (1,172), provider delivery (723), socket connect (423), command worker (342), database (267), and windows (215).
- **Each site has a proposed incident code.** They are a starting list, not final names. Implementation checks each site before adding its incident.

**What production already shows** (counts from the production `server.log`; causes marked unverified have not been traced):

| Message                                               |   Count | Status                                                                                                                                                      | What it means for this design                                                                                                                      |
| ----------------------------------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider runtime journal drain failed`               |   2,275 | Historical fault. Every record has an SQL error, and 737 say `disk I/O error`. Those disk errors cluster on August 1, not during the September 27 incident. | Needs `DB_WRITE_FAILED` with the SQLite error code, plus a disk health sample. Do not use the August errors to explain the September freeze.       |
| `provider.runtime_event_pump.quarantined_event`       |   2,264 | Fault. Every record is a decode error.                                                                                                                      | The incident must keep the event type and the field that failed to decode, so the provider change behind it can be found.                          |
| `orchestration lifecycle command rejected`            |  28,997 | Guard working as intended, cause of repetition unverified. 28,986 are `thread.turn.start` without the exact binding revision.                               | Record who sent it (renderer, agent or reactor) and the revision it had against the current one. Something is repeatedly sending a stale revision. |
| `stale orchestration synchronization acknowledgement` | 155,108 | Unverified. 47% of all log lines.                                                                                                                           | Record which of the three checks failed. Then decide whether it is expected (lower it to debug) or a fault.                                        |
| `Rejected streaming RPC admission.`                   |   6,233 | Guard working as intended, cause of repetition unverified. 6,053 are duplicate subscriptions.                                                               | Record the connection and lease, to show whether one renderer subscribes twice.                                                                    |

These five are the first incidents to build in the foundation, because they already fire in production.

## Concepts

### 1. Trace context: one ID for one action

Every user or agent action gets a `traceId` when it starts: a key press, a click, an MCP request, a timer or a boot task. The ID travels on:

- renderer events;
- WebSocket RPC metadata;
- server commands and durable command receipts;
- decider and projector events;
- provider intents and calls;
- MCP gateway requests.

Each hop records its own `spanId` and its parent span. The format follows W3C Trace Context and OpenTelemetry, so we can export to standard tools later without a rewrite.

A retry keeps the `traceId` and gets a new `attemptId`. The command ID stays the authority for idempotency. The trace ID is for navigation only.

### 2. Checkpoints

A checkpoint is a small record meaning "this action reached step X". Every step of a critical flow writes one, including on success, so a stall shows exactly where the action stopped.

- Checkpoints are cheap: IDs, a step name and a timestamp.
- They go to the rolling detail journal (see [Storage](#storage)), not to the incident table.
- They are never logged as text.

### 3. Expectations: things that should happen within N ms

When an action implies that something should follow, the code _arms_ an expectation. Examples:

- the turn starts;
- the first output arrives;
- the stop takes effect;
- every window leaves the thread.

The later step _resolves_ the expectation. If the deadline passes first, the watchdog writes an incident that says which checkpoint was reached last.

This is how "nothing happened" gets recorded. Examples: stuck in Thinking, Enter not sending, Stop not working.

### 4. Incidents: one structured record per failure or oddity

An incident is written for:

- every rejection, error, timeout, retry, fallback and quarantine;
- every limit reached;
- every missed expectation;
- every invariant violation;
- every failed call to an external system.

The incident is written where the failure is decided, together with the evidence of _why_: the expected value, the actual value and the check that failed.

Repeats of the same incident with the same key collapse into one row, with a count and first and last times. A new kind of failure is never suppressed.

### 5. Invariants: states that must never exist

Watchers check cross-component consistency, both when state changes and on a slow periodic sweep. Examples:

- The projection says a turn is running, but the provider session is idle, or the reverse.
- A thread has two running turns.
- A thread's `providerTurnId` does not match its Penkra turn.
- A command was refused, but a state change was recorded for it.
- A queued turn is older than its deadline and nothing is running on the thread.
- An archived thread has a running turn or a queued turn.
- A window shows a thread that no longer exists or is archived.

### 6. Provenance: "last changed by"

Important state rows record the `traceId` and time of the change that last set them. That includes a thread's active turn, turn state, queue entries, session bindings, archive state and connection state.

When an incident depends on that state, it copies the provenance. We can then follow the cause back hours or days without keeping hours of detail. For example, "write refused because the active turn is T; T was set by trace X at 04:12".

### 7. External calls

Every call to something Penkra does not control records an outcome, even on success, into the detail journal. Failures and slow calls also become incidents. External systems include:

- model CLIs and app servers (Claude, Codex, OpenCode);
- sign-in and token refresh;
- the network;
- Docker and the website backend;
- the update server;
- the file system;
- child processes.

Each record includes the phase (spawn, handshake, session resume, request accepted, first event, terminal), the elapsed time, the budget, the process ID and the exit code or signal.

### 8. Health samples and watchdogs

Each process samples its own health every 5 s:

- event-loop lag;
- CPU;
- RSS and heap;
- open handles;
- the queue depth and age of the oldest item.

Each process also checks that the others are alive: the desktop main process, the server, each renderer and each provider child.

- Missed heartbeats become incidents, recorded by a process that is still alive.
- Machine-level data is included: load average, free memory, and disk free on the data volume.

This is what separates "the computer was overloaded" from "Penkra was blocked" from "a provider hung".

## Shapes

These are illustrative TypeScript shapes, not final schemas.

```ts
type TraceContext = {
  traceId: string; // W3C 16-byte hex
  spanId: string; // 8-byte hex
  parentSpanId?: string;
  attemptId?: string; // new per retry / reconnect
};

type Correlation = {
  threadId?: string;
  turnId?: string; // Penkra turn
  providerTurnId?: string; // provider's turn / session turn
  commandId?: string;
  intentId?: string;
  windowId?: string;
  connectionId?: string; // provider connection
  mcpRequestId?: string;
};

type Env = {
  appVersion: string; // "0.14.2"
  build: string; // git sha
  channel: "production" | "dev" | "test";
  instance?: string; // numbered Dev instance
  bootId: string; // one per process start
  process: "desktop-main" | "server" | "renderer" | "provider-child";
  os: string; // "darwin 25.3.0"
};

type Checkpoint = TraceContext &
  Correlation & {
    at: string; // wall clock ISO
    mono: number; // monotonic ms within the process
    flow: FlowName; // "send", "stop", "archive", …
    step: string; // "server.received", "provider.first_event", …
    outcome?: "ok" | "rejected" | "failed" | "timed_out" | "cancelled";
    elapsedMs?: number;
  };

type Expectation = TraceContext &
  Correlation & {
    id: string;
    kind: string; // "turn.first_output"
    armedAt: string;
    deadlineMs: number;
    resolvedAt?: string;
    outcome: "pending" | "met" | "missed" | "cancelled" | "unknown_after_restart";
  };

type Incident = TraceContext &
  Correlation & {
    id: string;
    kind: IncidentKind;
    code: string; // stable, reviewed error code: "COMMAND_DISPATCH_TIMEOUT"
    severity: "error" | "warn";
    where: string; // "server/orchestration/OrchestrationEngine"
    summary: string; // one sentence, no user content
    expected?: Record<string, Scalar>;
    actual?: Record<string, Scalar>;
    limit?: { name: string; value: number; observed: number };
    lastCheckpoint?: string;
    provenance?: { field: string; setByTraceId: string; setAt: string }[];
    context: Record<string, Scalar>; // allowlisted keys only
    health?: HealthSample; // nearest sample at time of incident
    env: Env;
    fingerprint: string; // kind + code + where; used for collapsing
    count: number;
    firstAt: string;
    lastAt: string;
    detailWindow: { from: string; to: string }; // detail journal range pinned
  };

type IncidentKind =
  | "command.rejected"
  | "command.failed"
  | "expectation.missed"
  | "limit.exceeded"
  | "timeout"
  | "invariant.violated"
  | "external.failed"
  | "external.slow"
  | "process.unresponsive"
  | "process.crashed"
  | "recovery.performed" // we repaired something; say what and why
  | "diagnostics.degraded"; // we lost diagnostic data (drops, write failures)

type HealthSample = {
  at: string;
  process: Env["process"];
  eventLoopLagMs: number;
  cpuPct: number;
  rssMb: number;
  queueDepth?: number;
  oldestQueuedMs?: number;
  machineLoad1m: number;
  freeMemMb: number;
  diskFreeMb: number;
};
```

### Example: stuck in Thinking

```json
{
  "kind": "expectation.missed",
  "code": "TURN_OUTPUT_SILENT",
  "where": "server/orchestration/expectations",
  "summary": "Running turn produced no provider event for 60s",
  "threadId": "…",
  "turnId": "…",
  "providerTurnId": "…",
  "expected": { "maxSilenceMs": 60000 },
  "actual": {
    "silenceMs": 61230,
    "providerState": "running",
    "providerPidAlive": true,
    "providerCpuPct": 0
  },
  "lastCheckpoint": "provider.event_received",
  "context": {
    "provider": "claudeAgent",
    "deliveryQueueDepth": 4,
    "deliveryBlockedByThreadId": "…"
  },
  "health": { "process": "server", "eventLoopLagMs": 1900, "machineLoad1m": 11.2, "freeMemMb": 380 }
}
```

This one incident shows three things: the provider process was alive but idle; provider delivery was blocked behind another thread; and the machine was under load.

### Example: Enter did nothing

The expectation `send.accepted` (2 s) is armed in the renderer when the key handler fires. The incident is written by the renderer, and it lists the checkpoints that were reached:

```
composer.key_enter → composer.preflight_ok → ws.request_sent → (missing) server.received
```

It includes the socket state (`connecting`, attempt 3, the current handshake time and the 3 s deadline). The failure is in transport, not in the composer.

### Example: write refused (caller turn inactive)

```json
{
  "kind": "command.rejected",
  "code": "CALLER_TURN_INACTIVE",
  "where": "server/agent/mcpTransport",
  "expected": { "activeTurnId": "turn:A" },
  "actual": { "callerTurnId": "turn:B", "callerTurnSource": "background-task-notification" },
  "provenance": [
    { "field": "thread.activeTurnId", "setByTraceId": "…", "setAt": "2026-09-27T04:12:03Z" }
  ]
}
```

## Flow map

Every flow lists its checkpoints, its expectations and the incident codes it can produce. This table is the coverage contract. The first build instruments the flows marked **P1**.

| Flow                             | Checkpoints                                                                                                                             | Expectations (default)                                                         | Incident codes                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Send (P1)**                    | key/click → preflight → ws sent → server received → command accepted → turn queued/started → provider accepted → first event → terminal | accepted 2 s; turn started 10 s; first output 30 s; silence while running 60 s | `SEND_PREFLIGHT_REJECTED`, `WS_NOT_CONNECTED`, `COMMAND_REJECTED_*`, `TURN_START_TIMEOUT`, `TURN_OUTPUT_SILENT`        |
| **Stop (P1)**                    | click → command accepted → interrupt sent to provider → provider acknowledged → turn terminal                                           | terminal 5 s                                                                   | `STOP_NOT_EFFECTIVE`, `PROVIDER_INTERRUPT_FAILED`                                                                      |
| **Play / continue (P1)**         | click → decider checks → turn started → first event                                                                                     | turn started 5 s                                                               | `PLAY_REJECTED` (with the failing check), `TURN_START_TIMEOUT`                                                         |
| **Queue (P1)**                   | enqueued → dispatched → started                                                                                                         | starts within turn budget after the prior turn ends                            | `QUEUE_STALLED`, `QUEUE_ORDER_VIOLATION`                                                                               |
| **Command worker (P1)**          | received → queued → dequeued → lock acquired → committed → published → replied                                                          | dispatch within 45 s (existing limit)                                          | `COMMAND_DISPATCH_TIMEOUT` (with the holding command, its step and hold time), `LOCK_WAIT_EXCEEDED`                    |
| **Provider delivery (P1)**       | intent appended → claimed → adapter phase (spawn, handshake, resume) → call accepted → first event → cursor advanced                    | provider start 120 s (existing), per-phase budgets                             | `PROVIDER_START_TIMEOUT` (with the slow phase), `DELIVERY_BLOCKED` (blocked thread and duration), `INTENT_QUARANTINED` |
| **Socket connect (P1)**          | bootstrap requested → open → negotiated → feature socket open                                                                           | per attempt 3 s (existing)                                                     | `WS_HANDSHAKE_SLOW`, `WS_RECONNECT_LOOP` (count, durations)                                                            |
| **Agent / MCP writes (P1)**      | request received → turn authority resolved → operation run                                                                              | reply within operation budget                                                  | `CALLER_TURN_INACTIVE` (both paths), `SCOPE_DENIED`, `MCP_TIMEOUT`                                                     |
| **Turn reconciliation (P1)**     | runtime state read → decision → repair applied                                                                                          | none                                                                           | `recovery.performed` with before/after state; `TURN_STATE_DIVERGED` invariant                                          |
| **Archive (P2)**                 | click → command accepted → queued turns dropped → windows notified → windows left                                                       | windows left 2 s                                                               | `ARCHIVE_REFUSED_RUNNING`, `ARCHIVED_THREAD_STILL_OPEN`                                                                |
| **Thread create (P2)**           | request → created → first turn                                                                                                          | created 5 s                                                                    | `CREATE_TIMEOUT`, `CREATE_COMPENSATED` (orphan cleanup)                                                                |
| **Windows (P2)**                 | open → route resolved → thread loaded                                                                                                   | loaded 3 s                                                                     | `ROUTE_TARGET_MISSING`, `RENDERER_UNRESPONSIVE`, `RENDERER_CRASHED`                                                    |
| **Sign-in / token refresh (P2)** | start → provider response → stored                                                                                                      | 30 s                                                                           | `AUTH_FAILED` (code only), `TOKEN_REFRESH_FAILED`                                                                      |
| **App update (P3)**              | check → download → verify → install → relaunched on the new version                                                                     | per phase                                                                      | `UPDATE_*` (merge in `macUpdateDiagnostics`)                                                                           |
| **Database (P2)**                | open → migrate → maintenance → checkpoint                                                                                               | per operation                                                                  | `DB_BUSY`, `DB_MIGRATION_FAILED`, `DB_MAINTENANCE_SLOW`                                                                |
| **Apps / extensions (P3)**       | load → operation run                                                                                                                    | per operation                                                                  | `APP_OPERATION_FAILED`, `APP_TIMEOUT`                                                                                  |
| **Boot / shutdown (P1)**         | process start → server ready → renderer connected; shutdown requested → drained                                                         | ready 20 s                                                                     | `BOOT_SLOW` (with the slow stage), `UNCLEAN_SHUTDOWN` (detected at the next boot)                                      |

## Storage

A separate database file, `userdata/diagnostics/diagnostics.sqlite`. It is kept separate from `state.sqlite` for two reasons:

- Diagnostic writes never contend with application writes.
- Diagnostics still work when the main database is locked, slow or being repaired.

Separate files avoid the main database lock; they do not isolate synchronous CPU or disk work from
the server event loop. Import, indexing, pruning, and export must run off the socket admission
loop, with bounded queues and a measured per-batch budget.

This database is never authoritative. Deleting it loses history, not data.

| Table          | Contents                                                                                   | Kept                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `incidents`    | the Incident shape above; indexed by thread, turn, trace, kind, code, time                 | per [Retention](#retention)                                                            |
| `detail`       | checkpoints, external call outcomes, resolved expectations (the rolling "flight recorder") | rolling; pinned rows kept with their incident                                          |
| `expectations` | pending expectations only, so they survive a restart                                       | until resolved; after a restart, pending ones become `unknown_after_restart` incidents |
| `health`       | health samples                                                                             | rolling, thinned to one per minute after 24 h                                          |
| `meta`         | schema version, drop counters, last prune, app version at prune                            | always                                                                                 |

**Surviving a crash.** Each process writes first to a small append-only JSONL spool file of its own:

- The renderer sends to desktop main.
- Desktop main and the server write their own spools.
- The server imports the spool into SQLite in batches.

On the next boot, any leftover spool is imported and an `UNCLEAN_SHUTDOWN` incident is written.
A hard freeze preserves only records that reached the spool before the freeze; a surviving peer's
missed-heartbeat record and the next boot's unclean-shutdown record help bound the missing interval.

**Cost limits.**

- Writes are batched, at most every 250 ms. Incidents are flushed immediately.
- The spool is capped per process. Drops are counted locally while the diagnostics database is
  unavailable, then imported into `meta` and reported as a `diagnostics.degraded` incident after
  recovery. A crash or full disk can lose the last unflushed counter, so the next boot also checks
  spool sequence gaps and reports uncertainty rather than claiming a complete record.

## Retention

- **Hard ceiling:** 1 GB across the database and spools. When usage is over 80%, the oldest unpinned detail is deleted first, then the oldest health samples, then the oldest incidents.
- **Detail:** kept until space is needed. For a pruning window, measured production volume (~1.2 MB/day of text today) suggests days to weeks of full detail. We will measure the real rate in Dev before fixing any numbers.
- **Detail around an incident:** the detail from 10 minutes before to 2 minutes after each incident is pinned and kept with it. Provenance links reach causes older than that window.
- **Incidents:** 90 days.
- **On app update:** preserve unresolved incidents and their pinned detail with their original
  app version, build, and process boot ID. Start a new build segment for fresh records. Normal
  retention and the hard size cap still apply. A migration must never discard older evidence
  before it can read and retain that segment; if migration fails, leave the old file intact and
  record diagnostic degradation in the new segment. This keeps a failed pre-update attempt
  available when the operator updates Penkra and then investigates it.

## Noise cleanup (part of the same work)

1. **Stale acknowledgement warnings.** Find out why "stale orchestration synchronization acknowledgement" fires 155k times.
   - If it is expected, lower it to debug.
   - If it is a real fault, fix it and record it as an incident.
2. **Rotate `server.log`.** Use 10 MB × 10 files, like the other logs. First check its overlap with `server-child.log`, and remove the duplicate if they duplicate each other.
3. **Success-path text logs.** Remove success lines (command received and accepted, stream opened and closed, startup stage started and completed) once checkpoints replace them. Keep text logs for errors and for boot.
4. **Collapse repeats.** Repeated identical text log lines collapse into one line with a count.
5. **Log level rules:**
   - `error` means an incident was written.
   - `warn` means something degraded but recovered.
   - `info` is for boot, shutdown and configuration only.
   - Everything else is `debug`, off by default.

## Access

- `penkra diagnostics incidents [--thread <id>] [--since <t>] [--kind <k>] [--code <c>]`: a paged list that follows `pageInfo.nextCursor` like every other list.
- `penkra diagnostics thread <id>`: one ordered timeline for a thread, covering incidents, pinned detail and the provenance chain, joined to turn and message IDs from the main database.
- `penkra diagnostics trace <traceId>`: every checkpoint for one action, across processes.
- `penkra diagnostics export [--thread] [--since]`: a local bundle, allowlisted fields only. Sending it anywhere is a later decision.
- `ThreadDiagnosticsQuery` and the existing `ProviderRuntimeDiagnosticEpisodes` table are folded into this system.

No UI and no prompt changes.

## Coverage rules

Coverage is enforced the same way test coverage is.

1. **One way to fail.** Server code raises domain failures through helpers (`reject(code, expected, actual)`, `timeout(limit, observed)`) that write the incident. A lint rule flags a bare `Effect.fail`, a bare `Effect.timeout` or a `catchAll` in `apps/server/src/orchestration`, `provider`, `agent` and `ws` that does not go through them.
2. **Every limit is named.** Each timeout, cap and budget constant is registered in one `limits.ts`, so every limit shows up in its incident with its name and value.
3. **Tests assert incidents.** Existing rejection and timeout tests also assert that the expected incident code was written. A shared test helper makes this one line.
4. **A fault injection suite.** It runs the known failure boundaries in Dev and checks that each produces an incident naming the boundary:
   - a delayed handshake;
   - a blocked command stage;
   - a slow provider start;
   - a provider killed mid-turn;
   - a renderer crash;
   - a server freeze;
   - a hung provider;
   - a full disk.
5. **The gap rule.** When a real incident cannot be explained from its record, the missing checkpoint or field is filed as a coverage defect and fixed before the behaviour fix.

## QA with diagnostics

- Scripted flows drive a numbered Dev instance through RPC and Playwright: send, stop, play, queue, archive, multi-window, thread create, reconnect and provider switch. No computer use.
- **Pass:** every script meets its expectations, and `penkra diagnostics incidents --since <run start>` returns zero unexplained incidents.
- An incident that a script _intended_ to cause (for example, sending to an archived thread) must appear with the expected code. If it is missing, that is a coverage failure.
- QA reports cite incident IDs and trace IDs instead of screenshots.

## Rollout sequence (version to be approved separately)

1. **Foundation:**
   - trace context end to end;
   - the checkpoint, expectation and incident APIs;
   - `diagnostics.sqlite` with spools, retention and CLI reads;
   - health sampling;
   - the noise cleanup and `server.log` rotation.
2. **P1 flows:** send, stop, play, queue, command worker, provider delivery, socket connect, agent/MCP writes, reconciliation, boot.
3. **Coverage enforcement:** the lint rule, `limits.ts`, the test helper and the fault injection suite.
4. **Scripted QA** with the zero-new-incidents gate.
5. **Only then** investigate the open production bugs from real traces: the five production findings in the failure inventory, turn authority, reconciliation marking turns interrupted, the dispatch stall, cross-thread delivery blocking and slow socket handshakes. Each fix must cite the incident and trace that prove its cause.

P2 and P3 flows follow in the same release if time allows. Otherwise they go in the next release, with the gap listed.

## Open points

- The diagnostic architecture, current incident patch, and unrelated product work are separate
  changes. The release inventory must name each included commit or working-tree change explicitly;
  copying a dirty checkout wholesale would mix incomplete features with incident diagnostics.
