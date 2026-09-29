# Diagnostics design (0.14.3)

Status: approved implementation contract. Source: the operator-approved design at
`cbd0567ee`, with the 0.14.3 decisions below. Implementation progress is tracked
in repository-root `TODO.md`, not in this contract.

## Goal

Every failure in Penkra must leave enough evidence to find its root cause **without reproducing it**.

- If an incident cannot be explained from what was recorded, that is a defect in our tracing (a coverage gap), just as an untested path is a test coverage gap.
- The first fix for a coverage gap is to record what was missing. We do not fix the behaviour until a trace proves the cause.

This follows the operator's rule: "I'd rather we don't solve anything than 'solve' something without a FULL ROOT 100% confident trace."

Builds on:

- [`production-thread-stall-evidence-2026-09-27.md`](production-thread-stall-evidence-2026-09-27.md): measured stall boundaries that current logging could not explain.
- An earlier draft, `production-observability-design-2026-09-27.md`. It is uncommitted in the release worktree, and its content is merged into this document.

## Decisions already made

| Topic                | Decision                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content              | Diagnostics store IDs, states, timings and error codes only. Conversation content already lives in the main database and is joined by ID. No prompt text, model output, tool arguments, credentials, paths or raw URLs. |
| Disk budget          | 1 GB ceiling for all diagnostics. Normal pruning should keep it far below that.                                                                                                                                         |
| Pruning on update    | Diagnostics accumulate until an app update, then reset completely, so every record belongs to the current version.                                                                                                      |
| UI                   | None. Recording is completely silent.                                                                                                                                                                                   |
| Agents               | Diagnostics are readable through the normal `penkra` CLI. Nothing is added to prompts or agent instructions.                                                                                                            |
| Sending traces to us | Decided later. The design keeps everything local and exportable.                                                                                                                                                        |
| Deadlines            | We choose defaults and tune them from real incidents.                                                                                                                                                                   |
| QA                   | Scripted automation (Playwright or RPC), not computer use. A run passes only if its scripts pass **and** zero new incidents are recorded.                                                                               |

### 0.14.3 decisions

1. Ship the complete design in 0.14.3, including all failure sites in the inventory and all listed flows. The P1/P2/P3 labels set implementation order, not release exclusions.
2. Every installed app update deletes the entire diagnostics database and every process spool before recording the new installation's events, including a rebuild installed with the same version number. The reset identity is the app version, commit hash, and bundle signature; version text alone is insufficient. No unresolved incident or pinned detail carries over. A stale process must never reset the installed bundle's store.
3. Every failure site is in scope, including paths outside the named flows. A site is covered only when its failure decision produces an incident with a stable code and enough allowlisted evidence to explain the cause.
4. Do not import rows from `operational_diagnostics` or `provider_runtime_diagnostic_episodes`. Existing producers write to the new store from cutover onward. Keep their existing legacy writes and tool responses unchanged while adding the new writes. The old rows remain in the main database until normal database retention removes them; they are not diagnostic history for this version.

### Frozen v1 storage contract

The database is `userdata/diagnostics/diagnostics.sqlite`. An interprocess
diagnostics lifecycle lock serializes the installation identity check, reset,
database creation, spool import, and each write's identity check. A process
whose running bundle identity differs from the bundle currently installed on
disk is stale: it cannot reset or write SQLite. It may write only its own spool,
marked stale; the current process counts those records as dropped with a reason
and does not import them. A packaged process re-reads the installed bundle
identity before each lifecycle operation. Only a process whose running identity
matches it may reset when the store identity differs. Dev and unpackaged builds
have no installed bundle, so their running identity is authoritative. All timestamps are UTC
ISO 8601, durations are integer milliseconds, identifiers are text, and structured
fields are JSON objects validated against the privacy allowlist before entering a
spool. A spool record has a version, process boot ID, monotonically increasing
sequence, event type, and the same allowlisted payload stored in SQLite. A unique
`(boot_id, sequence)` key makes crash replay idempotent.
Desktop spools also carry Electron's validated `osMajor` so incident environments
retain the product version when the server imports them. The server probes its
own product version once per process, with a bounded timeout; a failed probe
records `unknown`.

Desktop spool writers leave one-eighth of the total cap free, up to 128 MiB,
while the server store is absent. This space lets an update write its durable
loss manifest even if desktop spools otherwise fill their writable budget.
Before the desktop main process posts a diagnostic write to its worker, it
fsyncs a small `desktop.worker_ack` expectation to its own spool. The worker
resolves that expectation in its spool after handling the write. An unresolved
receipt from a crashed process, or one still unacknowledged after 30 seconds,
produces `DIAGNOSTICS_DROPPED`. Import accepts the resolution before the arm
without creating a false miss. The renderer does not await this IPC.
On reset, the current process may first remove old SQLite and other files that
carry no unreported spool or ledger loss; it retains every counted spool and
ledger until their loss counts are durable. A crash before that point leaves
those counted files for the next startup to process.

| Table                  | Required columns                                                                                                                                                                                                                                                                                     | Indexes and lifecycle                                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `meta`                 | `key TEXT PRIMARY KEY`, `value TEXT NOT NULL`                                                                                                                                                                                                                                                        | `schema_version=1`, `app_version`, `build_id`, `reset_at`, per-process drop counts and last prune. The bundle identity is held by the lifecycle identity file; there is no installer generation counter.     |
| `detail`               | `id INTEGER PRIMARY KEY`, `boot_id`, `sequence`, `at`, `mono_ms`, `event_type`, `flow`, `step`, `trace_id`, `span_id`, `parent_span_id`, `attempt_id`, `thread_id`, `turn_id`, `command_id`, `correlation_json`, `payload_json`, `pinned_until`                                                      | Unique `(boot_id, sequence)`; indexes on `(trace_id, at)`, `(thread_id, at)`, and `at`. Event types are `checkpoint`, `external_outcome`, and `expectation_resolved`.                                        |
| `incidents`            | `id TEXT PRIMARY KEY`, `fingerprint`, `kind`, `code`, `severity`, `where_name`, `summary`, `thread_id`, `count`, `first_at`, `last_at`                                                                                                                                                               | Unique active fingerprint; aggregate lookup and repeat count only. It does not replace occurrence evidence.                                                                                                  |
| `incident_occurrences` | `id TEXT PRIMARY KEY`, `incident_id`, `boot_id`, `sequence`, `at`, `trace_id`, `span_id`, `attempt_id`, `thread_id`, `turn_id`, `command_id`, `expected_json`, `actual_json`, `limit_json`, `context_json`, `provenance_json`, `health_json`, `last_checkpoint`, `pin_from`, `pin_until`, `env_json` | Unique `(boot_id, sequence)`; indexes on `(at, id)`, `(thread_id, at)`, `(trace_id, at)`, `(incident_id, at)`. Every occurrence survives folding and has its own pinned detail window. QA counts these rows. |
| `expectations`         | `id TEXT PRIMARY KEY`, `kind`, `trace_id`, `span_id`, `attempt_id`, `thread_id`, `turn_id`, `correlation_json`, `armed_at`, `deadline_at`, `deadline_ms`, `last_checkpoint`, `boot_id`                                                                                                               | Index on `deadline_at`. Only pending expectations live here; resolution moves to `detail`. A restart resolves leftovers as `unknown_after_restart` incidents.                                                |
| `health`               | `id INTEGER PRIMARY KEY`, `boot_id`, `process`, `at`, `event_loop_lag_ms`, `cpu_pct`, `rss_mb`, `heap_mb`, `open_handles`, `queue_depth`, `oldest_queued_ms`, `machine_load_1m`, `free_mem_mb`, `disk_free_mb`                                                                                       | Index on `(process, at)`. Thin samples older than 24 h to one per minute.                                                                                                                                    |
| `provenance`           | `entity_kind`, `entity_id`, `field`, `set_by_trace_id`, `set_at`                                                                                                                                                                                                                                     | Primary key `(entity_kind, entity_id, field)`; latest change only.                                                                                                                                           |

The v1 code registry is fixed below. A new failure site may add a reviewed code,
but must not manufacture a code from exception text, provider output, a URL, or
user data. `COMMAND_REJECTED_*` and `UPDATE_*` in the flow map are families whose
members must be explicitly registered before use.

`summary` is a fixed, content-free sentence selected by incident code from a
reviewed template registry, with no exception text or user value interpolated.
`where_name` is a registered source-site token, not a path or arbitrary string.
`env_json` has exactly the validated scalar keys `appVersion` (semver),
`buildId` (hex commit ID), `channel` (`production`, `dev`, `test`), optional
`instance` (bounded numbered Dev identifier), `bootId` (generated hex),
`process` (registered process enum), `osFamily` (registered enum),
`osMajor` (nonnegative integer or `unknown` when OS version lookup fails), and health numbers. Unknown keys and
free-form values are rejected before spool append and again on CLI export.

| Area                      | Stable incident codes                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send, turn, queue         | `SEND_PREFLIGHT_REJECTED`, `SEND_ACCEPT_TIMEOUT`, `WS_NOT_CONNECTED`, `COMMAND_REJECTED`, `TURN_START_TIMEOUT`, `TURN_OUTPUT_SILENT`, `STOP_NOT_EFFECTIVE`, `PROVIDER_INTERRUPT_FAILED`, `PLAY_REJECTED`, `QUEUE_STALLED`, `QUEUE_ORDER_VIOLATION`                                                                                                                                                                                                                |
| Worker, provider          | `COMMAND_DISPATCH_TIMEOUT`, `LOCK_WAIT_EXCEEDED`, `PROVIDER_START_TIMEOUT`, `DELIVERY_BLOCKED`, `INTENT_QUARANTINED`, `PROVIDER_CALL_FAILED`, `PROVIDER_CALL_SLOW`, `PROVIDER_EVENT_DECODE_FAILED`, `PROVIDER_RUNTIME_JOURNAL_DRAIN_FAILED`                                                                                                                                                                                                                       |
| Socket, MCP, state        | `WS_HANDSHAKE_SLOW`, `WS_RECONNECT_LOOP`, `REJECTED_STREAMING_RPC_ADMISSION`, `SYNC_ACK_STALE`, `CALLER_TURN_INACTIVE`, `SCOPE_DENIED`, `MCP_TIMEOUT`, `TURN_STATE_DIVERGED`, `INVARIANT_VIOLATED`, `RECOVERY_PERFORMED`                                                                                                                                                                                                                                          |
| Lifecycle and other flows | `ARCHIVE_REFUSED_RUNNING`, `ARCHIVED_THREAD_STILL_OPEN`, `CREATE_TIMEOUT`, `CREATE_COMPENSATED`, `ROUTE_TARGET_MISSING`, `RENDERER_UNRESPONSIVE`, `RENDERER_CRASHED`, `AUTH_FAILED`, `TOKEN_REFRESH_FAILED`, `UPDATE_CHECK_FAILED`, `UPDATE_DOWNLOAD_FAILED`, `UPDATE_VERIFY_FAILED`, `UPDATE_INSTALL_FAILED`, `DB_BUSY`, `DB_WRITE_FAILED`, `DB_MIGRATION_FAILED`, `DB_MAINTENANCE_SLOW`, `APP_OPERATION_FAILED`, `APP_TIMEOUT`, `BOOT_SLOW`, `UNCLEAN_SHUTDOWN` |
| Diagnostics and process   | `PROCESS_UNRESPONSIVE`, `PROCESS_CRASHED`, `EXPECTATION_MISSED`, `DIAGNOSTICS_DROPPED`, `DIAGNOSTICS_WRITE_FAILED`, `DIAGNOSTICS_CAP_REACHED`, `EXTERNAL_CALL_FAILED`, `EXTERNAL_CALL_SLOW`                                                                                                                                                                                                                                                                       |

All limits use integer bytes or milliseconds. The named-limit registry owns the
values used by code and the incident's `limit` field:

| Limit                                                                           |                                 Frozen default |
| ------------------------------------------------------------------------------- | ---------------------------------------------: |
| Total diagnostics (SQLite, WAL, SHM, and all spools)                            |                    1,073,741,824 bytes (1 GiB) |
| Prune start                                                                     |                           80% of the total cap |
| Per-process spool                                                               |                                         16 MiB |
| Desktop diagnostics worker queue / message / shutdown drain / ack               |          256 / 64 KiB / 2 seconds / 30 seconds |
| OS product version probe                                                        |                                         250 ms |
| Batch interval                                                                  |    at most 250 ms; incidents flush immediately |
| Incident age                                                                    |                 90 days within one app version |
| Incident detail pin                                                             | 10 min before through 2 min after the incident |
| Health sample / heartbeat                                                       |                                      every 5 s |
| Health thinning                                                                 |  after 24 h, one sample per process per minute |
| Send acceptance / turn start / first output / running silence                   |                       2 s / 10 s / 30 s / 60 s |
| Stop terminal / Play start / command dispatch / provider start                  |                       5 s / 5 s / 45 s / 120 s |
| Socket handshake attempt / archive windows / create / window load / auth / boot |            3 s / 2 s / 5 s / 3 s / 30 s / 20 s |
| `server.log` rotation                                                           |                      10 MiB per file, 10 files |

### Privacy allowlist

Only known keys and scalar values may enter `correlation_json`, `payload_json`,
`expected_json`, `actual_json`, `context_json`, and `provenance_json`. Allowed
values are: generated trace/span/attempt and entity IDs; enumerated flow, step,
phase, provider, state, outcome, failure code, process and source names; booleans;
numeric counters, sizes and timings; sanitized operating-system error codes;
and the timestamp of a state change. Reject unknown keys and free-form strings
at the producer boundary. In particular, never record message or tool content,
prompts, model output, credentials, file contents, filesystem paths, raw URLs,
request bodies, exception messages, or arbitrary provider payloads. The local
export applies the same allowlist again.

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

The full inventory is in [`diagnostics-failure-inventory.md`](./diagnostics-failure-inventory.md), and every site is listed in [`diagnostics-failure-sites.md`](./diagnostics-failure-sites.md). It is a read-only scan of `apps/server`, `apps/web` and `apps/desktop`, plus a count of the production `server.log`.

- **5,327 places where something can fail.** 446 of them fail silently, and 4,923 have no thread, turn, command or connection ID in the local statement.
- **The largest flows:** provider delivery (706), apps and extensions (603), socket connect (420), command worker (342), database (265) and windows (215).
- **Each site has a proposed incident code.** Implementation checks each site and adds its reviewed stable code to the v1 registry before using it. The inventory does not waive the every-failure coverage target.

**What production already shows** (counts from the production `server.log`; causes marked unverified have not been traced):

| Message                                               |   Count | Status                                                                                                                        | What it means for this design                                                                                                                         |
| ----------------------------------------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider runtime journal drain failed`               |   2,275 | Fault. Every record has an SQL error, and 737 say `disk I/O error`.                                                           | Needs `DB_WRITE_FAILED` with the SQLite error code, plus a disk health sample. The disk errors may be linked to the freeze on 2026-09-27; unverified. |
| `provider.runtime_event_pump.quarantined_event`       |   2,264 | Fault. Every record is a decode error.                                                                                        | The incident must keep the event type and the field that failed to decode, so the provider change behind it can be found.                             |
| `orchestration lifecycle command rejected`            |  28,997 | Guard working as intended, cause of repetition unverified. 28,986 are `thread.turn.start` without the exact binding revision. | Record who sent it (renderer, agent or reactor) and the revision it had against the current one. Something is repeatedly sending a stale revision.    |
| `stale orchestration synchronization acknowledgement` | 155,108 | Unverified. 47% of all log lines.                                                                                             | Record which of the three checks failed. Then decide whether it is expected (lower it to debug) or a fault.                                           |
| `Rejected streaming RPC admission.`                   |   6,233 | Guard working as intended, cause of repetition unverified. 6,053 are duplicate subscriptions.                                 | Record the connection and lease, to show whether one renderer subscribes twice.                                                                       |

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

Repeats of the same incident with the same key update one aggregate row, with a
count and first and last times. **Every occurrence also gets its own immutable
row**, including its trace, time, actual values and detail pin window. A repeat
is a new incident for the QA gate; the aggregate is only a navigation aid.

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

These are illustrative TypeScript API shapes. The v1 SQLite schema and allowlist
above are the persisted contract.

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
  appVersion: string; // "0.14.3"
  buildId: string; // validated hex git sha, or "unknown" when unavailable; never a fake SHA
  channel: "production" | "dev" | "test";
  instance?: string; // bounded numbered Dev identifier
  bootId: string; // one per process start
  process: "desktop-main" | "server" | "renderer" | "provider-child";
  osFamily: "darwin" | "linux" | "windows";
  osMajor: number | "unknown";
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
    where: string; // registered source-site token
    summary: string; // fixed sentence keyed by code; no interpolation
    expected?: Record<string, Scalar>;
    actual?: Record<string, Scalar>;
    limit?: { name: string; value: number; observed: number };
    lastCheckpoint?: string;
    provenance?: { field: string; setByTraceId: string; setAt: string }[];
    context: Record<string, Scalar>; // allowlisted keys only
    health?: HealthSample; // nearest sample at time of incident
    env: Env;
    fingerprint: string; // kind + code + where; aggregate lookup only
    occurrenceId: string; // immutable, unique for every failure
    count: number; // aggregate count; each occurrence remains queryable
    firstAt: string;
    lastAt: string;
    detailWindow: { from: string; to: string }; // per-occurrence range pinned
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

The expectation `send.accepted` (2 s) is armed when dispatch begins. A missed
deadline records `SEND_ACCEPT_TIMEOUT`; `SEND_PREFLIGHT_REJECTED` describes an
actual preflight refusal. The timeout incident lists the checkpoints that were
reached:

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

Every flow lists its checkpoints, its expectations and the incident codes it can produce. This table is the coverage contract. P1, P2 and P3 determine implementation order; all are required in 0.14.3.

| Flow                             | Checkpoints                                                                                                                             | Expectations (default)                                                         | Incident codes                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Send (P1)**                    | key/click → preflight → ws sent → server received → command accepted → turn queued/started → provider accepted → first event → terminal | accepted 2 s; turn started 10 s; first output 30 s; silence while running 60 s | `SEND_PREFLIGHT_REJECTED`, `SEND_ACCEPT_TIMEOUT`, `WS_NOT_CONNECTED`, `COMMAND_REJECTED_*`, `TURN_START_TIMEOUT`, `TURN_OUTPUT_SILENT` |
| **Stop (P1)**                    | click → command accepted → interrupt sent to provider → provider acknowledged → turn terminal                                           | terminal 5 s                                                                   | `STOP_NOT_EFFECTIVE`, `PROVIDER_INTERRUPT_FAILED`                                                                                      |
| **Play / continue (P1)**         | click → decider checks → turn started → first event                                                                                     | turn started 5 s                                                               | `PLAY_REJECTED` (with the failing check), `TURN_START_TIMEOUT`                                                                         |
| **Queue (P1)**                   | enqueued → dispatched → started                                                                                                         | starts within turn budget after the prior turn ends                            | `QUEUE_STALLED`, `QUEUE_ORDER_VIOLATION`                                                                                               |
| **Command worker (P1)**          | received → queued → dequeued → lock acquired → committed → published → replied                                                          | dispatch within 45 s (existing limit)                                          | `COMMAND_DISPATCH_TIMEOUT` (with the holding command, its step and hold time), `LOCK_WAIT_EXCEEDED`                                    |
| **Provider delivery (P1)**       | intent appended → claimed → adapter phase (spawn, handshake, resume) → call accepted → first event → cursor advanced                    | provider start 120 s (existing), per-phase budgets                             | `PROVIDER_START_TIMEOUT` (with the slow phase), `DELIVERY_BLOCKED` (blocked thread and duration), `INTENT_QUARANTINED`                 |
| **Socket connect (P1)**          | bootstrap requested → open → negotiated → feature socket open                                                                           | per attempt 3 s (existing)                                                     | `WS_HANDSHAKE_SLOW`, `WS_RECONNECT_LOOP` (count, durations)                                                                            |
| **Agent / MCP writes (P1)**      | request received → turn authority resolved → operation run                                                                              | reply within operation budget                                                  | `CALLER_TURN_INACTIVE` (both paths), `SCOPE_DENIED`, `MCP_TIMEOUT`                                                                     |
| **Turn reconciliation (P1)**     | runtime state read → decision → repair applied                                                                                          | none                                                                           | `recovery.performed` with before/after state; `TURN_STATE_DIVERGED` invariant                                                          |
| **Archive (P2)**                 | click → command accepted → queued turns dropped → windows notified → windows left                                                       | windows left 2 s                                                               | `ARCHIVE_REFUSED_RUNNING`, `ARCHIVED_THREAD_STILL_OPEN`                                                                                |
| **Thread create (P2)**           | request → created → first turn                                                                                                          | created 5 s                                                                    | `CREATE_TIMEOUT`, `CREATE_COMPENSATED` (orphan cleanup)                                                                                |
| **Windows (P2)**                 | open → route resolved → thread loaded                                                                                                   | loaded 3 s                                                                     | `ROUTE_TARGET_MISSING`, `RENDERER_UNRESPONSIVE`, `RENDERER_CRASHED`                                                                    |
| **Sign-in / token refresh (P2)** | start → provider response → stored                                                                                                      | 30 s                                                                           | `AUTH_FAILED` (code only), `TOKEN_REFRESH_FAILED`                                                                                      |
| **App update (P3)**              | check → download → verify → install → relaunched on the new version                                                                     | per phase                                                                      | `UPDATE_*` (merge in `macUpdateDiagnostics`)                                                                                           |
| **Database (P2)**                | open → migrate → maintenance → checkpoint                                                                                               | per operation                                                                  | `DB_BUSY`, `DB_MIGRATION_FAILED`, `DB_MAINTENANCE_SLOW`                                                                                |
| **Apps / extensions (P3)**       | load → operation run                                                                                                                    | per operation                                                                  | `APP_OPERATION_FAILED`, `APP_TIMEOUT`                                                                                                  |
| **Boot / shutdown (P1)**         | process start → server ready → renderer connected; shutdown requested → drained                                                         | ready 20 s                                                                     | `BOOT_SLOW` (with the slow stage), `UNCLEAN_SHUTDOWN` (detected at the next boot)                                                      |

## Storage

A separate database file, `userdata/diagnostics/diagnostics.sqlite`. It is kept separate from `state.sqlite` for two reasons:

- Diagnostic writes never contend with application writes.
- Diagnostics still work when the main database is locked, slow or being repaired.

This database is never authoritative. Deleting it loses history, not data.

| Table                  | Contents                                                                                   | Kept                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `incidents`            | fold aggregates, indexed by fingerprint and last time                                      | until their last occurrence is pruned                                                  |
| `incident_occurrences` | every incident's trace, timestamp, values and detail window                                | per [Retention](#retention); the QA gate counts rows here                              |
| `detail`               | checkpoints, external call outcomes, resolved expectations (the rolling "flight recorder") | rolling; pinned rows kept with their incident                                          |
| `expectations`         | pending expectations only, so they survive a restart                                       | until resolved; after a restart, pending ones become `unknown_after_restart` incidents |
| `health`               | health samples                                                                             | rolling, thinned to one per minute after 24 h                                          |
| `provenance`           | latest last-changed-by value for important state                                           | until superseded or version reset                                                      |
| `meta`                 | schema version, drop counters, last prune, app version at prune                            | always                                                                                 |

**Surviving a crash.** Each process writes first to a small append-only JSONL spool file of its own:

- The renderer sends to desktop main.
- Desktop main and the server write their own spools.
- The server imports the spool into SQLite in batches.

On the next boot, every complete, synced spool record is replayed idempotently.
An unclean process exit writes `UNCLEAN_SHUTDOWN` on recovery. A hard freeze
preserves only records whose spool sync completed; a torn final record, a failed
spool sync, or storage hardware failure can lose evidence. The recovery record
includes the last durable sequence and a bounded loss/gap count when known.

Before the server store opens, the recorder holds at most 256 incidents in
memory. It drains eight per event-loop turn after installation, so startup does
not wait for these writes. Overflow drops the oldest entries and later records
their exact count in a `DIAGNOSTICS_DROPPED` incident. This memory buffer is not
crash durable. If the backend fails before its store opens, desktop records the
backend startup failure with a fixed code and failing phase in its own store.

Desktop main never synchronously writes or fsyncs diagnostics during a send. The
diagnostics worker reserves and syncs blocks of 1,024 queue slots, then grants
them to main over IPC. Main assigns slots in memory. The worker refills when half
of the granted slots remain. Main holds a bounded startup buffer until the first
grant arrives, then sends those records with credits. A record is accepted only after the worker has
synced its spool entry and acknowledged it. On an unclean exit, reconciliation
counts reserved slots without imported entries as `possibly_lost`, a conservative
upper bound that includes unused credits. Desktop bootstrap also fsyncs one
conservative queue-startup marker before accepting writes, covering a crash
before the first credit grant or between worker instances. A clean close
removes it. A crash with this marker records `lost_count_unknown`; it cannot
determine how many buffered items existed. A five-second first-credit timeout
drops and durably counts buffered items, and clean shutdown counts any buffer
still waiting for credits. Reconciliation also records
`lost_count_unknown` for every unclean exit with an active credit block. This
condition does not assert that exhaustion occurred: exact crash-time exhaustion
would require a durable main-thread write or blocking worker acknowledgement.
If credits run out while the process survives, main keeps an exact in-memory
overflow count. Once the worker responds, it writes that count durably and
records `DIAGNOSTICS_DROPPED`. The QA gate fails on growth in confirmed loss,
`possibly_lost`, or `lost_count_unknown`, as well as exact overflow.

The runnable benchmark is `bun scripts/benchmark-desktop-diagnostics-queue.mjs`
after building the desktop diagnostics worker. Its `inMemoryMicrobenchmark`
compares synchronous reservation with worker-credit enqueue using an immediate
fake worker; those figures isolate enqueue overhead only. On the development
host, one 2,000-write run through a real Node worker measured main-thread
enqueue p50 0.001 ms and p95 0.003 ms, and durable acknowledgement p50
38.976 ms and p95 75.586 ms. Two refill fsync round trips were observed;
the slower one took 85.177 ms. Two samples do not support a refill p95.
The run produced 2,000 acknowledgements across three credit blocks. These
measurements include `postMessage`, worker persistence, and acknowledgement,
but do not measure Electron rendering or represent a latency guarantee.

**Cost limits.**

- Writes are batched, at most every 250 ms. Incidents are flushed immediately.
- The spool is capped per process. Reserve fixed-size, preallocated loss-ledger
  space at process start, outside the normal event budget. When capacity or a
  SQLite/spool write fails, increment a per-process durable drop counter there
  before returning control. The server imports counters into `meta` and writes
  one `diagnostics.degraded` occurrence with the count and reason when space is
  available. A physical failure that also prevents updating the preallocated
  ledger cannot be promised durable; emit a bounded stderr signal and mark the
  next recovered sequence gap as unknown. Never claim that such data survived.

## Retention

- **Hard ceiling:** 1 GB across SQLite, WAL, SHM, all spools, loss ledgers, and
  recovery files. Before a write, reserve enough room for its worst-case spool
  and SQLite/WAL growth; check actual total size again after the transaction and
  checkpoint. If the reserve cannot be made, count and report the dropped event.
  SQLite disables cache spill during a transaction and sets a per-write page
  limit so the database, one WAL frame per page, WAL-index regions, and other
  diagnostics files fit inside the ceiling. A busy checkpoint rejects the write.
  Do not allow a successful write to leave the directory over the ceiling.
  Pruning begins at 80% and continues in this order: oldest unpinned detail;
  oldest health; occurrences past 90 days and their now-unused detail; oldest
  remaining occurrences with their pinned windows; orphaned pinned detail.
  Recompute aggregate counts after occurrence deletion. Import or account for
  crash-recovery spools before deleting any of their records; if unimported
  spools alone reach the cap, reject and count new writes. Never silently remove
  the only durable copy of an event.
- **Detail:** kept until space is needed. For a pruning window, measured production volume (~1.2 MB/day of text today) suggests days to weeks of full detail. We will measure the real rate in Dev before fixing any numbers.
- **Detail around an incident:** the detail from 10 minutes before to 2 minutes after each occurrence is pinned while that occurrence remains. Under cap pressure, evict the oldest occurrence and its pinned window together, with a retained eviction count. Provenance links reach causes older than that window.
- **Incidents:** 90 days.
- **On app update: a full reset.** The first process whose own running identity
  matches the currently installed bundle reads its app version, commit hash and
  bundle signature, then deletes all diagnostics (database, spools and loss
  ledgers) under the lifecycle lock if that identity differs from the store.
  `meta` records the identity, reset time and a fresh random reset generation.
  The clean QA gate compares that generation across its run, including when
  the initial incident list is empty. A stale process cannot reset or
  write SQLite; its marked spool is counted as dropped rather than imported.

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

- `penkra diagnostics incidents [--thread <id>] [--since <t>] [--kind <k>] [--code <c>]`: a paged list of individual occurrences (with aggregate count) that follows `pageInfo.nextCursor` like every other list.
- `penkra diagnostics thread <id>`: one ordered timeline, interleaving occurrences, pinned detail and provenance changes and joining turn and message IDs from the main database. Separate arrays do not satisfy this command.
- `penkra diagnostics trace <traceId>`: every checkpoint for one action, across processes.
- `penkra diagnostics export [--thread] [--since]`: a local bundle, allowlisted fields only. Sending it anywhere is a later decision.
- `ThreadDiagnosticsQuery` and the existing `ProviderRuntimeDiagnosticEpisodes` table are folded into this system.

No UI and no prompt changes.

## Coverage rules

Coverage is enforced the same way test coverage is.

1. **One way to fail.** Server code raises domain failures through helpers (`reject(code, expected, actual)`, `timeout(limit, observed)`) that write the incident. Coverage lint scans all production code in `apps/server`, `apps/web`, `apps/desktop` and shared runtime packages, including silent catches, bare throws, rejected effects and timeout paths. A documented, reviewed exception is required for a site that truly cannot fail. A scan of selected server folders is insufficient.
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

The coverage check tracks each catch, throw, explicit rejection and timeout site by file,
line, column and syntax kind. A `diagnostics-covered: CODE where` marker means that the same
block records that failure before the marked site. A `diagnostics-propagates: CODE where` marker requires a verified path from that failure to a registered recording boundary; a matching call somewhere in the boundary file does not establish that path and the marker remains uncovered until route validation is implemented. Each boundary is registered with its stable incident code, location and source file, and the checker verifies that one recording call contains both values. Validation failures and
rethrows also require a recording boundary. An exact-site exception is allowed
only for a path proven unreachable; it records the proof, reviewer and tracking
issue. A stale exception fails the check. The check must cover all production roots
before it is added to the default lint gate.

## QA with diagnostics

- Scripted flows drive a numbered Dev instance through RPC and Playwright: send, stop, play, queue, archive, multi-window, thread create, reconnect and provider switch. No computer use.
- Provider-dependent clean QA flows use the scripted Codex app-server fixture
  under `scripts/diagnostics-qa/` in isolated Dev userdata. The fixture is a
  test executable outside every packaged app bundle and is never imported by
  production code. Its protocol is tested, and the bundle exclusion check must
  pass after a build. The QA report labels provider coverage as
  `scripted-fixture; real provider not covered`; it makes no real-provider claim.
- Each flow script exits successfully and writes a result file at
  `PENKRA_DIAGNOSTICS_QA_REPORT_PATH` naming its flow, a passing status and its
  required live-app assertions. The gate independently reads fresh, successful
  app checkpoints for every required assertion on one trace after each script;
  assertions listed only in the script report do not count. The app process also
  signs a flow-specific action result under a QA-only run secret, and the gate
  generates a fresh random challenge before each flow. The app signs the
  challenge with the action result; the gate requires that exact challenge and
  trace, preventing replay of an earlier valid result from the same run. The
  secret is removed from the
  flow-script environment. A zero exit without
  that report, a mismatched flow or missing checkpoints fails the gate.
- **Pass for the clean QA run:** every script meets its expectations, and `penkra diagnostics incidents --since <run start>` returns **zero new occurrences**, including repeats of an existing aggregate. No new incident is exempt from this count.
- Expected-failure and fault-injection scripts run separately from the clean gate. Each intended failure (for example, sending to an archived thread) must produce its expected code and occurrence, or coverage fails. Their incident-producing interval is excluded only by running a separate clean gate with a fresh baseline, not by filtering incidents from that gate.
- QA reports cite incident IDs and trace IDs instead of screenshots.

## Rollout (0.14.3)

1. **Foundation:**
   - trace context end to end;
   - the checkpoint, expectation and incident APIs;
   - `diagnostics.sqlite` with spools, retention and CLI reads;
   - health sampling;
   - the noise cleanup and `server.log` rotation.
2. **P1 flows:** send, stop, play, queue, command worker, provider delivery, socket connect, agent/MCP writes, reconciliation, boot.
3. **Coverage enforcement:** the lint rule, `limits.ts`, the test helper and the fault injection suite.
4. **Scripted QA** with the zero-new-incidents gate.
5. **Only then** investigate the open 0.14.2 bugs from real traces: the five production findings in the failure inventory, turn authority, reconciliation marking turns interrupted, the dispatch stall, cross-thread delivery blocking and slow socket handshakes. Each fix must cite the incident and trace that prove its cause.

P2 and P3 flows and the full failure-site inventory are required before the 0.14.3 diagnostics work is considered complete.

## Open points

- The uncommitted drafts in the release worktree (`production-observability-design-2026-09-27.md`, the stall evidence note, the `docs/README.md` edit and an extra cross-thread test in `ProviderCommandReactor.test.ts`) belong to another thread. The evidence note is copied here. Their owner should commit them to this branch or discard them. They are not part of 0.14.1.
