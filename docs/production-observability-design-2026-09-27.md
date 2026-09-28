# Production incident observability proposal — 2026-09-27

Status: design for discussion. No runtime behavior or diagnostic collection is changed by this document.

The local 0.14.1 worktree now contains a separate, narrowly scoped diagnostic patch for the active incident: slow worker stages, runtime-event processing, provider-derived command stages, SQLite holds, and event-loop delay. It is not installed in production and does not implement the end-to-end trace, retention, or export system proposed here.

## Why the current incident is still open

The [thread stall evidence](./production-thread-stall-evidence-2026-09-27.md) establishes three distinct boundaries: cross-thread provider delivery is serialized, unrelated commands can wait before starting, and production WebSocket handshakes can exceed the browser's three-second attempt deadline. It does not identify what held the production command worker or delayed the backend handshake, nor the phase that held Strategy's Claude turn start. A longer socket deadline might hide a symptom without explaining the stalled server. No behavioral fix should be declared from these observations alone.

## Current observability inventory

| Surface       | Present                                                                                                                        | Missing for this incident                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Renderer      | In-memory 512-sample composer send lifecycle buffer; WebSocket console warnings; feedback sends environment and thread summary | Durable trace across renderer restart; exact socket stage and attempt correlation; incident export            |
| Server RPC    | Command received, accepted, rejected logs with command/thread identifiers                                                      | Queue wait, worker stage durations, timer lag, and connection-to-command correlation                          |
| Orchestration | Durable command receipts, event sequence, provider intent claims/cursors, worker exception logs                                | A joined timeline from user send through command queue, commit, publication, claim, and provider call         |
| Provider      | Timeout/failure logs and runtime events                                                                                        | Timings for adapter startup, session discovery/resume, call acceptance, first event, and terminal outcome     |
| Process       | Five-minute memory snapshots, process/child/projection diagnostics RPC, desktop child log capture                              | Event-loop lag, worker occupancy/wait, socket admission timing, crash-adjacent diagnostic bundle              |
| Storage       | Desktop main and child logs rotate at 10 MB with 10 backups each; App runtime diagnostics have a separate 2 MiB journal        | Server `server.log` uses a file logger without rotation in `serverLogger.ts`; unified retention/export policy |

Production `server.log` measured 86 MiB. It contains about 24,034 command-received lines, 23,400 accepted lines, and 90 rejected lines. Counts describe log volume, not the outcome of a particular command. These logs may overlap desktop child capture; that needs a test before deleting or changing either sink. The durable orchestration journal is application state and must not be pruned as if it were a diagnostic log.

## Proposed diagnostic contract

Define structured lifecycle records for every critical boundary, including a cheap receipt of success. This identifies the last boundary reached when a later one fails. Record detailed error and slow-path context when triggered; avoid routine payload dumps and token-level event logs.

Every record has a schema version, wall timestamp, monotonic elapsed time within its process, app version/build, numbered instance, process boot ID, component, operation name, attempt ID, command ID when assigned, thread ID where relevant, trace/span IDs, phase, outcome, elapsed/budget milliseconds, and a bounded error code. A lifecycle outcome is one of `started`, `completed`, `failed`, `timed_out`, `cancelled`, or `unknown_after_restart`; a timeout names its owner and the last acknowledged downstream boundary. IDs are generated before renderer dispatch, retained across retries where command identity is retained, and copied through the WebSocket request and durable command/intent metadata. A new connection or delivery attempt gets its own attempt ID. Trace context aids navigation; command ID and journal sequence remain the authority for replay and idempotency. Link asynchronous durable intents to the request that created them.

Capture these phase boundaries first:

1. **Send and transport:** click/submission, local admission, bootstrap socket requested/open/error, compatibility negotiation, feature socket requested/open/error, RPC sent, server received, receipt returned, UI receipt applied. Separate each socket's elapsed time and timeout budget.
2. **Command worker:** queued, dequeued, maintenance lock wait/acquired, receipt lookup, transaction started/committed, projection publication, reply. Record queue depth and oldest age as low-cardinality aggregate metrics; name the active command only in local diagnostic records.
3. **Provider delivery:** intent appended, cursor seen, claim acquired, adapter/session phase entered, provider call issued/accepted, first event, terminal outcome, cursor advanced or quarantined. Record whether other threads were waiting behind the global reader, without logging their content.
4. **Recovery:** renderer reconnect, backend boot/shutdown, restored in-flight command/intent, reconciliation decision, retry/fence result, and user-visible final state.

Illustrative record, not a final wire format:

```json
{
  "schema": 1,
  "at": "2026-09-27T06:00:13.000Z",
  "bootId": "...",
  "traceId": "...",
  "attemptId": "...",
  "commandId": "...",
  "threadId": "...",
  "component": "command-worker",
  "phase": "queued",
  "outcome": "timed_out",
  "elapsedMs": 45000,
  "budgetMs": 45000,
  "lastReached": "server-received",
  "activeWorkerPhase": "maintenance-lock-wait",
  "errorCode": "COMMAND_ADMISSION_TIMEOUT"
}
```

That example would prove B waited for the maintenance lock only if the worker's independent stage record corroborated it. If that record is missing, the answer is “worker stage unknown,” and the missing record is an observability defect.

## Storage, noise, and privacy

- Keep structured metadata local by default in a bounded journal separate from the authoritative event database. Set size and age caps after measuring current rates; preserve a short pre-failure window and a longer post-failure window for each incident. Crash-safe writes require an explicit durability/overhead choice. Record dropped-record counts, journal write failures, and schema incompatibility as health signals.
- Preserve all critical transition receipts and all error, timeout, crash, and threshold-crossing records within the active retention window. Sample only optional detail from routine successes. Collapse repeated identical failures into first occurrence, last occurrence, count, and representative trace IDs, with a bounded per-episode sample. Never suppress a new failure class or recovery transition.
- Rotate and cap `server.log` after verifying its relationship with `server-child.log`, then reduce high-volume success prose only after structured receipts are proven to replace its diagnostic value. Do not prune existing production logs or the event journal as part of design review.
- Use an allowlist of fields. Exclude prompts, responses, tool arguments/results, credentials, auth headers, raw URLs, absolute paths, and raw exception messages by default. Provide bounded, reviewed error codes and sanitized stacks when useful. Existing redaction helpers are partial protection, not blanket proof that arbitrary text is safe.
- Add explicit “Export diagnostics for this issue” from a selected failed attempt. Show scope, time range, approximate bundle size, and sensitive-field policy; allow inspection before an explicit upload. Export should work offline. The current feedback form sends a summary but no linked trace bundle.

## Acceptance gate and rollout

First instrument the three unresolved incident boundaries in a numbered Dev instance without changing queue or timeout behavior. Use fault injection for a delayed eight-second socket handshake, a blocked command stage, a 120-second provider start, a crash/restart during a claimed intent, and a renderer restart. For each, export the bundle and verify a reviewer can identify the boundary, owning process/attempt, elapsed wait, outcome, and retry status without guessing. Repeat with Codex and Claude, fresh and restored threads, and simultaneous A/B sends. Include quiet success, repeated errors, offline export, and log sink failure cases.

Before production rollout, measure peak memory, write latency, CPU, disk growth, and records surviving a forced crash. Add automated schema/redaction and end-to-end correlation checks, plus an incident coverage checklist. Mark an incident “evidence complete” only when the observed trace distinguishes credible competing causes; otherwise record the missing boundary as a product defect and keep the cause open. Roll out instrumentation first, observe a comparable production occurrence, then approve any behavioral fix against that evidence.

## Standards informing the design

- [OpenTelemetry log correlation](https://opentelemetry.io/docs/specs/otel/logs/) joins logs to trace/span context and resource identity.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) defines interoperable trace identity propagation.
- [OpenTelemetry sampling guidance](https://opentelemetry.io/blog/2022/tail-sampling/) shows error/latency retention with a routine-success sample and documents memory/cost tradeoffs.
- [OpenTelemetry metrics](https://opentelemetry.io/docs/concepts/signals/metrics/) warns that high-cardinality attributes such as user IDs can grow aggregation state.
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) calls for interaction IDs, event outcomes, and exclusion or sanitization of secrets and sensitive data.
