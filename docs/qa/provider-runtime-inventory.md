# Provider runtime inventory

Evidence collected 2026-10-21 against `2692a93e1`, before the P26 refactor.
This is a source/evidence inventory, not a second implementation plan. The root
`TODO.md` owns decisions, order, and acceptance. No runtime behavior was changed.

## Scope and method

Inspected the lifecycle, discovery, error, and timing paths in:

- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/provider/Layers/{CodexAdapter,ClaudeAdapter,OpenCodeAdapter,ProviderHealth,ProviderDiscoveryService}.ts`
- `apps/server/src/{codexAppServerManager,codexAppServerTransport,codexErrorClassification}.ts`
- `apps/server/src/provider/{opencodeRuntime,supervisedProcessTeardown,providerUpdateCoordinator,providerCliVersionProbe,providerCliOutput,managedProviderArtifact,managedProviderArtifactInstaller,codexManagedAccountLogin,claudeManagedAccountLogin}.ts`
- Their external callers in `cleanCore`, `ProviderThreadSwitchCoordinator`,
  `wsRpc.ts`, and `main.ts`; the composer's discovery caller and query keys.

Searches enumerated `startSession`, `stopSession`, `interruptTurn`, their internal
aliases, scope/finalizer cleanup, process signals, timer/repeat/sleep calls, and
string/regex predicates. Enclosing functions and callers were inspected to
distinguish actual re-execution from a log message mentioning a retry.
Line references below are to the baseline above. Grouped rows enumerate the
sites implementing one mechanism; they do not imply all sites are independent
retries or process kills. Tests and generated/vendor code are excluded.

No live Penkra SQLite database was opened or copied. The discovery experiments
used separate Codex subprocesses, not the running account process; they started
no user turn. Captures were inspected in memory; raw catalog payloads and
credentials were not retained. The throwaway probe was removed afterward.

## Direct experimental evidence: P15

Two Production connection homes used the installed Codex `0.163.0` executable.
The control sequence was `initialize`, `model/list`, unrestricted `plugin/list`,
local-marketplace `plugin/list`, and `skills/list`, then orderly stdin close.

| Observation                                           | Connection home A | Connection home B |
| ----------------------------------------------------- | ----------------- | ----------------- |
| `model/list` response bytes                           | 7,877             | 7,877             |
| Unrestricted `plugin/list` response bytes             | 18,148,188        | 18,176,083        |
| `plugin/list` with `marketplaceKinds:["local"]` bytes | 150,731           | 405,483           |
| `skills/list` response bytes                          | 88,707            | 53,370            |
| Independent probe process exit                        | code 0, no signal | code 0, no signal |

Feeding the real unrestricted response into the unchanged `CodexJsonlFramer`
in 65,536-byte chunks produced `frame-too-large`, request ID 3,
`observedBytes=16842752`, `maxBytes=16777216`. The local response passed.
The probe intentionally did not invoke manager teardown. Source traces that
exception to `handleTransportFailure` and termination of the account process.

In home A, the unrestricted response contained marketplaces with 5 and 7,691
plugins. The current normalizer retained only the first marketplace: remote
entries did not fit its local-path contract. The local request returned 5 and
64 entries; the normalizer retained 5 and 62. Thus this is not merely a large
list the UI needs: much of the large response is discarded after transport.

A subsequent contract check of `plugin/installed {cwds:[cwd]}` on the installed
binary succeeded: `{marketplaces, marketplaceLoadErrors}`, 37,559 response
bytes. Its cwd was a different directory; that size is not a same-cwd benchmark.

Historical Production exits at 2026-10-20 23:20:35.954Z, 23:20:52.695Z, and
23:21:44.073Z recorded the same framer failure, `protocolClosed=true`,
`requestedStop=false`, code 0/no signal, and last request `plugin/list`.
Those older logs did not capture the failing response's request ID. The probes
reproduce the matching mechanism; they do not recover the original wire bytes.

## 1. Session start, stop, and interrupt sites

Abbreviations: PS = `provider/Layers/ProviderService.ts`; CM =
`codexAppServerManager.ts`; CA/CL/OA = Codex/Claude/OpenCode adapters in
`provider/Layers`. A session stop is not necessarily a process stop.

| Site                                     | Trigger / current action                                                              | Reason and ownership evidence                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `cleanCore/turnDispatch.ts:83,93`        | Runtime mode differs: stop session; missing session: start from selected native state | Runtime-mode change / demand-driven start                                                                                     |
| `ProviderThreadSwitchCoordinator.ts:139` | Interrupt current exact native turn before interrupt-deliver                          | Selection/send workflow, not process termination                                                                              |
| Same file `185,211`                      | Stop before connection/native-state copy, or before changed model                     | Selection change; two distinct branches                                                                                       |
| `cleanCore/threadLifecycle.ts:143,158`   | Retention archive; explicit archive/delete                                            | First call is inside an SQL transaction; second precedes deletion. A replacement must not lose transaction/ordering semantics |
| `cleanCore/ThreadSender.ts:419`          | Sender interrupt calls provider interrupt                                             | User Stop or interrupt-deliver; `wsRpc.ts:296` and gateway `477` route to sender                                              |
| PS `1270`                                | Stop active runtime whose managed isolation identity differs                          | Managed launch identity change during session resolution                                                                      |
| PS `1298`                                | Resume inactive binding during routable-session recovery                              | Request-demanded recovery; not a background timer                                                                             |
| PS `1448`                                | Start and persist a replacement under lifecycle lease                                 | Explicit start, with 60-second guard                                                                                          |
| PS `1466`                                | Retire partially started adapter after start deadline                                 | Startup cleanup, separately bounded at 10 seconds                                                                             |
| PS `1562`                                | Stop previous provider before replacement                                             | Cross-provider branch when no managed-launch resolver is configured                                                           |
| PS `1576,1578`                           | On failed cross-provider replacement, stop replacement then restart old adapter       | Compensating restoration; a real automatic start after failure, not merely logging                                            |
| PS `1838`                                | Route interrupt through authoritative provider turn ID                                | Uses urgent lifecycle path, outside ordinary lifecycle wait                                                                   |
| PS `2004`                                | Public stop: adapter stop, then directory removal                                     | Session disposal; no explicit reason argument today                                                                           |
| PS `2051`                                | Runtime-only stop, preserving native cursor and stopped binding                       | Idle/public runtime retirement; not identical to directory removal                                                            |
| PS `2135`                                | Claude idle callback calls runtime-only stop                                          | Checks idle generation, active native tasks, turn, session, and saved cursor                                                  |
| PS `2177`                                | Clear resume cursor stops runtime unless preservation requested                       | Native-state invalidation; must distinguish from archive/user Stop                                                            |
| PS `2372`                                | Shutdown calls every adapter's `stopAll`, then drains events                          | Application shutdown; `2398` clears idle timers                                                                               |
| CA `1635,1714,1785`                      | Delegate start, interrupt, stop to CM                                                 | Adapter wrapper, not another independent ownership policy                                                                     |
| CA `1550,1818`                           | Scoped resource finalizer / `stopAll` close manager                                   | Application/resource teardown                                                                                                 |
| CA `1804`                                | `stopAccount` delegates to manager                                                    | Connection sign-out/removal                                                                                                   |
| CM `1187`                                | Existing thread context stopped before new start                                      | Same-thread replacement; shared account process remains                                                                       |
| CM `1482`                                | Stop partially opened context on startup failure                                      | Cleanup before possible pre-open retry                                                                                        |
| CM `1843`                                | Native `turn/interrupt`                                                               | Explicit interrupt with active/review turn reconciliation                                                                     |
| CM `1894`                                | Repeat interrupt against refreshed review turn ID                                     | Actual retry after timeout and authoritative snapshot read                                                                    |
| CM `2169`                                | Interrupt active turn during `stopSession`                                            | Then `thread/unsubscribe`; awaits native close barrier                                                                        |
| CM `2469`                                | Interrupt the dedicated probe thread's turn on the shared account process             | Probe deadline cleanup, not the user's running turn                                                                           |
| CL `4559`                                | Stop prior context during start                                                       | Existing-session replacement under adapter lifecycle lock                                                                     |
| CL `4137`                                | SDK stream exits: complete/interrupt/fail turn, then internal stop                    | Provider exit, stream exception, or natural stream end                                                                        |
| CL `4865,4872,4879`                      | Incomplete install: stop context or close query and prove process exit                | Startup cancellation/failure cleanup                                                                                          |
| CL `5184`                                | `query.interrupt()`                                                                   | Explicit interrupt, 10-second acknowledgment guard                                                                            |
| CL `5265`                                | Public stop delegates to internal stop                                                | Thread-level SDK process retirement                                                                                           |
| CL `5412,5430`                           | `stopAll` / scope finalizer stop every context                                        | Also reap unproven failed starts and discovery children                                                                       |
| OA `3249`                                | Existing session context stopped before replacement                                   | Abort native session; close session scope; release pool lease                                                                 |
| OA `1123`                                | Shared `stopOpenCodeContext` aborts session                                           | Called at `1188,3249,3741,4214`; releases lease, does not kill pooled server on refcount zero                                 |
| OA `1353`                                | Unexpected event-stream/server failure cleanup aborts session                         | Emits error/exit and closes session scope                                                                                     |
| OA `2445`                                | Abort after native permission-policy failure                                          | Request/turn failure path with native side effect                                                                             |
| OA `3353,3428`                           | Abort resumed/started native session after startup failure                            | Cleanup, no prompt replay                                                                                                     |
| OA `3696`                                | `session.abort` then await `turnSettled`                                              | Explicit interrupt: HTTP ack alone does not settle the turn                                                                   |
| OA `3741`                                | Public stop calls shared context cleanup                                              | Emits session exit, removes session map entry                                                                                 |
| OA `4214,4217`                           | Stop all contexts, then runtime `stopAll`                                             | Actual pooled process teardown occurs in runtime layer                                                                        |
| OA `4234,4236`                           | Stop connection's sessions, then runtime `stopAccount`                                | Connection removal/sign-out                                                                                                   |
| `wsRpc.ts:650`                           | Adapter `stopAccount` on connection disconnect                                        | External process-stop authority, outside PS                                                                                   |
| `main.ts:436`                            | Automatic runtime installer callback invokes adapter `stopAll`                        | Runtime replacement, outside PS                                                                                               |

### Ownership differences the refactor must preserve or explicitly change

1. CM `stopSession:2143` interrupts/unsubscribes one native conversation. It
   does **not** terminate the account process. `closeAccountProcess` is separate.
2. OpenCode's pool is not evidence of one process per account. OA `3274` passes
   `launch.isolationKey` and thread gateway credentials into the runtime;
   `3268` explicitly rejects a non-thread-scoped gateway. The server/directory
   MCP registry is shared, so merging these processes could replace one thread's
   gateway identity with another's. P26's account-process shorthand needs review
   against this established credential boundary.
   `provider/Layers/ProviderLaunchResolver.ts:211–214` confirms the concrete key:
   Codex uses installation + profile; other harnesses additionally include
   native-state identity. This is not just a misleading name on the pool.
3. Public Stop currently interrupts the turn through the urgent path; it is not
   the same operation as disposing the thread's resumable runtime. `ensure`
   serialization must not make that escape hatch wait behind a hung start.
4. Claude idle retirement already protects live native background tasks. The
   new ready-state rule must account for those, not only visible turn state.

## 2. Timing and repeated work

“Disposition” describes the applicable root-plan rule or an evidence gap for
planner review; it does not approve an additional change.

| Site                                     | Current value / wait                                                                                                   | Event or structured outcome / disposition                                                                                                                                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PS `482`                                 | 30-minute Claude idle timer                                                                                            | Intentional resource policy, kept by P26; lifecycle state replaces displacement bookkeeping                                                                                                                                                             |
| PS `1459,1467`                           | Start 60 s, timed-out-start cleanup 10 s                                                                               | Genuine readiness/exit deadlines; retain named typed outcomes under P26                                                                                                                                                                                 |
| CM `506`                                 | 2 s to settle parked human requests during close                                                                       | Part of stop drainage; stop completion/tree-exit ownership must replace silent best-effort completion                                                                                                                                                   |
| CM `2437`                                | 20 s connectivity probe                                                                                                | Waits for actual probe turn terminal event; currently deadline can return a negative probe result                                                                                                                                                       |
| CM `3076`                                | 50 ms stderr multiline flush                                                                                           | Diagnostic batching, not turn recovery. Stream end/new timestamp also flushes; final unterminated record has no explicit boundary                                                                                                                       |
| CM `3877`                                | Every JSON-RPC request defaults to 20 s                                                                                | Response ID/abort/pipe close are real events. Startup/interrupt vs catalog/general request deadlines need separate treatment; today they all share this default                                                                                         |
| CM `3981`, default at `1052`             | 750 ms after legacy `task_complete`                                                                                    | Synthesizes `turn/completed` if newer notification missing. Silence is not completion evidence; P26 review/delete row                                                                                                                                   |
| CM `4543`                                | Version subprocess 4 s, then SIGKILL                                                                                   | CLI exit event; bounded health/version probe, separate from session readiness                                                                                                                                                                           |
| CA `110`                                 | 50 attempts, 20 ms apart                                                                                               | Exact native rollout adoption polls a file after a completed turn. Needs a verified native rollout durability/availability event; that event is not established by this inventory                                                                       |
| CL `2166`                                | Context-usage control reply 1 s                                                                                        | On timeout permanently disables control for this context; errors become undefined usage. SDK result/cancellation ownership needed; not a start/stop deadline                                                                                            |
| CL `5186`                                | Interrupt 10 s                                                                                                         | Genuine interrupt acknowledgment deadline; retain typed result                                                                                                                                                                                          |
| CL `5616`                                | Connectivity probe 20 s                                                                                                | AbortController plus SDK cleanup; probe request/turn result, not a user-turn watchdog                                                                                                                                                                   |
| OA `1552,1595,1640`                      | Quiet windows: 10 s; final-answer shortcut up to 250 ms; another grace window                                          | Infers final text completeness/turn failure from inactivity; real ordered provider terminal facts must replace it                                                                                                                                       |
| OA `1910,1923`                           | Recovery reads after 2/5/10/20 s, then 60 s no activity                                                                | `session.messages` recovery ladder followed by synthesized terminal failure; P26 delete/review row, no automatic resend                                                                                                                                 |
| OA `2046,2102`                           | 500 ms inline wait for prompt/promptAsync                                                                              | Background submission continues; immediate failure returned only if it wins window. Admission vs acknowledgment must not be conflated                                                                                                                   |
| OA `4005`                                | Model-connectivity test 20 s                                                                                           | Temporary native session with tools disabled; delete in ensuring. Probe completion/abort event; not a runtime keepalive                                                                                                                                 |
| `opencodeRuntime:1075`                   | Server ready 20 s                                                                                                      | Parses native readiness stdout, races child exit; valid process-start deadline                                                                                                                                                                          |
| Same file `941`                          | Effect child force-kill-after 1,500 ms                                                                                 | Process scope cleanup; overlaps explicit supervised-tree teardown and must retain ownership proof                                                                                                                                                       |
| Same file `1340`                         | Optional agent list 2 s                                                                                                | Timeout/error silently yields empty agents; P25 catalog load must report failure, not successful empty inventory                                                                                                                                        |
| `ProviderHealth:543,619,698,762,816,917` | CLI probes 4 s; Claude/OpenCode health 20 s                                                                            | Probe subprocess completion; typed timeout already exists in version-probe outcome. Not all these calls are agent session starts                                                                                                                        |
| `ProviderHealth:1455`                    | Release advisory every 24 h                                                                                            | Latest-version advisory check; P26 pinned-version design deletes this mechanism                                                                                                                                                                         |
| `providerUpdateCoordinator:403`          | Automatic install cycle every hour                                                                                     | P26 deletes automatic latest checking/installing                                                                                                                                                                                                        |
| `supervisedProcessTeardown:88,173–245`   | 3 capture attempts/25 ms apart; poll 25 ms; descendant inspection 250 ms; TERM grace and force-exit wait 1,500 ms each | Root exit is observable; non-child descendant liveness currently comes from process-table inspection. Removing polling without another proof would break no-overlap ownership. Preserve proof; planner must distinguish this from turn-recovery polling |
| `managedProviderArtifactInstaller:484`   | Install 5 minutes                                                                                                      | Artifact/network/extraction deadline, not turn lifecycle. Exact-version installer is retained by P26; deadline classification is an adjacent concern                                                                                                    |
| `providerCliVersionProbe:17`             | Supplied caller timeout                                                                                                | Already returns `missing/failure/timeout/nonzero/success`; use structured outcome rather than re-reading error copy                                                                                                                                     |
| `codexManagedAccountLogin:218`           | Account verification 40 attempts/100 ms                                                                                | After login success, polls `account/read` until ChatGPT account visible. Auth-flow event ordering must be verified before deleting; not a user-message resend                                                                                           |
| `claudeManagedAccountLogin:81,99`        | Browser-open helper 15 s; exec callback 30 s                                                                           | Auth browser launch subprocess deadlines, not session lifecycle                                                                                                                                                                                         |

Timer clear operations are cleanup of the listed timers, not extra policies.
`ProviderDiscoveryService.ts` has no direct timer/sleep/retry primitive.

### Actual retries, fallback executions, and non-retries

| Site                                    | Behavior                                                                       | Classification / replacement evidence                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| CM `1123–1139`                          | Retry `plugin/list` without marketplace kinds on textual parameter failure     | Compatibility retry; P25 deletes old discovery path, uses supported `plugin/installed`                                             |
| CM `1155` and `2223`                    | Retry skills list using single-cwd parameter shape                             | Compatibility retry at reconciliation and ordinary discovery; pinned protocol removes both                                         |
| CM `1140` via `isPluginListUnavailable` | Missing plugin/list becomes successful skip                                    | Unsupported-method fallback, not a retry; pinned startup capability gate replaces it                                               |
| CM `1471–1492`                          | At most one fresh start after pre-thread-open transport failure                | Real automatic process reacquisition/start; protected from replay after thread-open request is sent. P26 says no automatic restart |
| CM `1889–1900`                          | Retry review interrupt with refreshed turn ID                                  | Real second interrupt; native terminal/review event and exact active turn are preferable to timeout/error-copy inference           |
| CM `2681–2693`                          | Acquisition waits/reaps closed process, then recurses                          | Demand-driven acquisition barrier, not a background restart loop. Preserve no replacement before exit proof                        |
| CA `99–111`                             | Rollout-file adoption retries                                                  | File availability, not inference/API retry; exact durability signal unverified                                                     |
| PS `1578`                               | Restore previous adapter after failed replacement                              | Actual compensating runtime start; distinct from provider retry events                                                             |
| OA `1910`                               | Repeated message-history reads                                                 | Read-recovery polling, not prompt resend                                                                                           |
| OA `1640–1669`                          | Second final-message snapshot after quiet window                               | Read-recovery retry; native SSE terminal/part ordering needs pinned-version contract evidence                                      |
| `opencodeRuntime:1432–1446`             | `models --verbose` failure retries `models`                                    | Text-selected CLI compatibility; pinned supported CLI determines one request                                                       |
| `supervisedProcessTeardown:173`         | Retry incomplete process-tree capture                                          | Safety proof retry, not agent work retry; cannot discard evidence or allow process overlap                                         |
| `codexManagedAccountLogin:202–218`      | Re-read account after login callback                                           | Auth readiness polling, distinct from workload delivery                                                                            |
| CL `3531–3535`                          | Display SDK `api_retry` event                                                  | Provider-owned retry telemetry; Penkra does not reissue the request here                                                           |
| CL `3507–3524`                          | Display SDK model-refusal fallback                                             | Provider-owned model reroute; no Penkra retry at this site                                                                         |
| CA `1410`, CM `3573`, OA `2572,3005`    | Display provider `willRetry` / retry status                                    | Structured provider telemetry, not independent Penkra retries                                                                      |
| Other catch/ignore paths                | Usage absent, diagnostics ignored, cleanup errors logged, empty optional lists | Not retries. Each remains a fidelity/error-propagation concern, not grounds for counting a resend                                  |

## 3. Text and regex decisions

This table covers predicates on provider errors/output and normalization of
provider event/tool strings in the named runtime files. It deliberately separates
presentation parsing from predicates that change lifecycle or retry behavior.
Where an upstream SDK supplies only text, no replacement field is invented.

| Site / expression group                                                      | Current decision                                          | Structured source or limitation                                                                                                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| PS `1990`, `issue.includes("no persisted provider binding exists")`          | Missing binding makes stop idempotent                     | Directory absence is already `Option`; retain typed absence through resolver instead of matching locally authored copy                                |
| CM `293–303` skills-list error phrases                                       | Select compatibility request shape                        | `CodexJsonRpcResponseError` retains `code/data`; pinned params remove fallback entirely                                                               |
| CM `306–313` plugin-list parameter phrases                                   | Remove marketplace filter and retry                       | Delete fallback under P25; installed plugin contract verified on 0.163.0                                                                              |
| CM `316–322` method-not-found phrases                                        | Suppress unavailable plugin discovery                     | JSON-RPC method-not-found code exists; pinned startup capability validation, not silent skip                                                          |
| CM `424,831`, timestamp/level/target stderr regex                            | Identify multiline diagnostic record                      | Stderr has no JSON envelope at this layer; central pinned-format parsing is appropriate, not session-control authority                                |
| CM `533`, token-usage stdout regex                                           | Ignore known non-protocol stdout                          | Stdout JSON envelope is the authoritative RPC shape; keep diagnostic noise distinct from valid/malformed envelopes                                    |
| CM `559–565`, duplicate-function-argument regex                              | Rewrite user-visible error                                | Presentation only; no demonstrated structured duplicate-field property. Centralize/version-test if retained                                           |
| CM `3099`, missing-custom-tool-output call-ID regex                          | Publish correlated native runtime diagnostic              | Text-only stderr diagnostic; no verified protocol field supplying this fact. Must not become a guessed turn/process action                            |
| CM `4399`, interrupt timeout phrase                                          | Enable review retry                                       | Typed local timeout with `method` can replace Penkra-authored string                                                                                  |
| CM `4402–4423`, type normalization and review substrings                     | Recognize entered/exited review items in snapshots        | Exact pinned item-type discriminants; native notification already checks `exitedReviewMode` exactly                                                   |
| CM `4469–4472`, ENOENT/command-not-found/not-found/filesystem.access phrases | Classify binary absence                                   | Native error `code`/spawn failure or filesystem result; broad “not found” is not proof of missing executable                                          |
| CM `691`, model `-codex` suffix                                              | Normalize model spelling                                  | Model identity/catalog normalization, not error retry; preserve exact provider IDs where available                                                    |
| CM `897`, status-name membership                                             | Classify active native turn                               | Exact structured status values (array membership, not natural-language sniffing)                                                                      |
| CM `3212`, `account/` method prefix                                          | Route protocol account notifications                      | Protocol method namespace, not error text                                                                                                             |
| CM `3779`, image MIME prefix                                                 | Accept native tool image data                             | MIME classification, not lifecycle policy                                                                                                             |
| CA `107–109`, exact rollout-unavailable error copy                           | Retry native rollout adoption                             | Local filesystem result should be a typed unavailable outcome; actual availability event remains unverified                                           |
| CA `220–230`, unknown-session/session-closed/stdin-closed phrases            | Map errors to not-found/closed adapter errors             | Local session maps and typed transport errors already identify these states; JSON-RPC `code/data` must be preserved                                   |
| CA `390–405`, normalized type substrings                                     | Map native item kinds                                     | Pinned protocol item `type` discriminants, not words appearing in future type names                                                                   |
| CL `595–597`, interruption phrases                                           | Classify stream exception as interrupted                  | Effect `Cause.hasInterruptsOnly`, pending interrupt identity, native process outcome. SDK-only textual exceptions need one version-tested classifier  |
| CL `630–634`, exit-code/signal text                                          | Treat 130/143/SIGINT/SIGTERM as benign                    | Owned child exit `code/signal` is observable. Whether external termination is interrupted vs failed is a product rule, not derivable from error prose |
| CL `643`, missing-conversation phrase                                        | Invalidate resume cursor and tracked tasks                | Material persistent-state effect. No verified SDK error discriminator for this message yet; inspect pinned SDK before selecting replacement           |
| CL `655–664`, result errors interrupt/aborted phrases                        | Mark SDK result interrupted                               | SDK `subtype/is_error` plus pending interrupt; textual `errors[]` remains a pinned classifier only if no exact field exists                           |
| CL `1111`, cancel phrase                                                     | Mark result cancelled                                     | Same limitation; structured SDK result/error variants first                                                                                           |
| CL `1118`, delta type contains thinking                                      | Classify reasoning vs assistant delta                     | Exact SDK delta discriminant, not substring                                                                                                           |
| CL `1172–1180`, EDE diagnostic prefixes and fields                           | Remove diagnostic-looking display lines                   | Content sanitation, not error recovery. No structured replacement established; can hide actual matching text and requires explicit review             |
| CL `1190–1206`, exact interruption sentence / punctuation-only regex         | Replace/hide user-visible error                           | Presentation classifier; structured turn status is available, no structured punctuation meaning exists                                                |
| CL `1334–1341`, unknown-session/not-found/closed phrases                     | Map arbitrary errors to session errors                    | Local `requireSession` already returns typed not-found/closed. Broad “not found” may refer to an unrelated resource                                   |
| CL `775–833`, tool-name substrings                                           | Categorize todo/agent/bash/file/MCP/web/image/read tools  | Tool identity, not error text. Some arbitrary MCP names have no native category field; do not invent one                                              |
| CL `552`, UUID regex                                                         | Validate native session identifier                        | Identifier validation, not retry policy                                                                                                               |
| CL `3736`, label membership                                                  | Deduplicate tool labels                                   | Exact data membership, not textual failure inference                                                                                                  |
| OA `309–324`, tool-name substrings                                           | Categorize tool activity                                  | Native tool name/status metadata, with same arbitrary-tool limitation as Claude                                                                       |
| OA `511,529`, text startsWith previous text                                  | Reconcile cumulative vs delta parts                       | Streaming text comparison, not error classification. Preserve content fidelity when changing adapters                                                 |
| OA `671–672`, context/token + overflow regex                                 | Classify context overflow                                 | Exact `error.name === "ContextOverflowError"` is already checked first; SDK error `name/data` should survive conversion                               |
| OA `3040`, abort regex                                                       | Suppress expected abort error                             | Pending abort turn ID is available; verify SDK abort error discriminator for pinned release rather than hiding arbitrary “abort” errors               |
| OA `778`, finish-reason membership                                           | Distinguish tool continuation from final answer           | Structured native finish value; exact membership, not natural-language matching                                                                       |
| OA `927,984`, session.next method prefixes                                   | Recognize native session activity                         | Typed protocol namespace, not error text                                                                                                              |
| `opencodeRuntime:261–264`, ready-prefix / URL regex                          | Detect CLI readiness and bound address                    | CLI stdout is the current readiness contract; no structured control channel proven. Version-test rather than inventing a different event              |
| Same file `734`, unknown-verbose option phrases                              | Retry model command without flag                          | Pinned CLI shape removes compatibility branch                                                                                                         |
| Same file `271,657,683`                                                      | Quote CLI tokens / scan whitespace in verbose JSON output | Data parsing, not lifecycle/error heuristics                                                                                                          |
| `ProviderHealth:283–299`, unknown command/login-required phrases             | Warning vs unauthenticated status                         | Exit status + pinned auth-status JSON are preferable; unsupported CLI is version gate, not a guessed warning                                          |
| Same file `310` JSON prefix check                                            | Find JSON output candidate                                | Framing/parser concern, not auth proof; success still requires decoding a marker                                                                      |
| Same file `1020`, timeout-detail sentence                                    | Preserve previous ready status on transient timeout       | Version probe already has typed `outcome:"timeout"`; currently lost in display status                                                                 |
| `providerCliOutput:26`, ENOENT/notfound phrases                              | Mark version command missing                              | Native spawn error code should remain typed through Effect wrapper                                                                                    |
| `claudeManagedAccountLogin:43,54`, URL regex / oauth path                    | Extract browser authorization URL                         | Auth-output parsing, not agent runtime failure. Keep URL host validation; no structured login callback replacement proven here                        |

`codexErrorClassification.ts` is a useful existing structured path: it uses
notification method, `willRetry`, and `error.codexErrorInfo`. It contains no
natural-language error matching. `ProviderDiscoveryService.ts` has no matching
`includes`/regex predicates. SDK/provider retries cannot be eliminated merely by
deleting telemetry branches in Penkra.

## 4. Process-ending paths

| Owner / entry                                         | Trigger                                                             | Actual effect / blast radius                                                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CM `terminateAccountProcess:2789`                     | Called by close or transport failure                                | Supervised entire child tree; every context on this pooled account process affected                                                                                  |
| CM `handleTransportFailure:3030`                      | Framer exception, stdout end, child error via listeners `2865–2920` | Marks protocol closed, detaches stdout, terminates shared process. Oversized response is incorrectly included today                                                  |
| CM `startAccountProcess:2779`                         | Initialization/account-read failure                                 | Closes just-started account process; startup cleanup                                                                                                                 |
| CM `getOrCreateAccountProcess:2682,2692`              | Previously closed/stopping entry acquired                           | Reap and await owned process close before replacement; prevents overlapping descendants                                                                              |
| CM `stopAll:2203`, `stopAccount:2851`                 | App/resource shutdown, update, connection removal                   | Close account process(es); not an individual turn request                                                                                                            |
| CM `closeAccountProcess:2812`                         | Explicit close authority                                            | Stops contexts, rejects pending work, closes stdin writer, proves tree exit                                                                                          |
| CM `onProcessExit/onProcessClose:2920–2945`           | Native process exit/stdio drained                                   | Reports lifecycle and affected thread exits; a consequence, not a new kill cause                                                                                     |
| CM version probe `4546`                               | 4-second version deadline                                           | SIGKILL of standalone probe, not account process                                                                                                                     |
| CM `stopSession:2143`                                 | One thread retired                                                  | Interrupt/unsubscribe, finish context; shared process survives. Native close may wait for `thread/closed`, which must be tested against pinned unsubscribe semantics |
| CL `performStopSessionInternal:4142–4184`             | Public stop, replace, stream end/error, shutdown                    | Stop task fibers/queue, `query.close`, supervised thread SDK process exit                                                                                            |
| CL failed-start cleanup `4553,4684,4865–4879`         | Start/install fails or cancels                                      | Retain failed owner until tree exit proven; no immediate replacement on unproven cleanup                                                                             |
| CL discovery cleanup `5332–5334,5514–5516,5560–5562`  | Temporary commands/models/agents query finishes or fails            | Close discovery query and reap its child, not a live thread child                                                                                                    |
| CL probe cleanup `5617,5658–5660`                     | Connectivity probe done/deadline                                    | Abort/close probe and reap child                                                                                                                                     |
| CL stopAll/finalizer `5412–5440`                      | Application/layer scope ends                                        | Stop thread contexts and reap failed-start/discovery leftovers                                                                                                       |
| OA `stopOpenCodeContext:1115`                         | Stop/replace/shutdown                                               | Abort native session, close session scope/release lease. Pool refcount decrement does not close server                                                               |
| OA unexpected exit `1325–1358`, `3196,3206`           | Event subscription ends/errors or server exits                      | Emit terminal session events, abort session, close scope. Event-stream failure is currently treated as whole session failure                                         |
| OA permission branch `2445`                           | Permission-policy failure                                           | Native session abort, not direct OS kill                                                                                                                             |
| OA failed-start abort `3353,3428`, scope close `3520` | Session update/setup fails                                          | Abort native session and release acquired scope; shared runtime server lifetime is separately owned                                                                  |
| `opencodeRuntime:978`                                 | Managed server scope finalizer                                      | Supervised process-tree teardown; Effect child also has kill settings at `941`                                                                                       |
| Same file `1151,1166,1212`                            | Explicit pool close, observed native exit, failed pool startup      | Close process scope; detach pool entry only after owned cleanup                                                                                                      |
| Same file `1248,1254,1258`                            | stopAll / stopAccount / runtime finalizer                           | Close matching pooled servers; zero-refcount release alone does not kill                                                                                             |
| `main.ts:436`                                         | Runtime installation succeeds                                       | Calls adapter stopAll before updated runtime use; affects every session of provider                                                                                  |
| `wsRpc.ts:650`                                        | Connection disconnect                                               | Calls adapter stopAccount; Connection-scoped process stop                                                                                                            |
| Managed login helpers                                 | Login/probe completes, fails or cancels                             | Standalone auth child stdin/kill cleanup, not live account process. Same JSONL framer is reused in Codex login                                                       |

The manager's request timeout deletes/rejects its pending request. It does not
directly call process termination. Treating every request error as an observed
process crash would therefore be inaccurate. Conversely, a framer exception is
currently escalated to process termination even when a valid response envelope
identifies the one request that could be failed instead.

## 5. Catalog and version boundary facts

| Boundary                                        | Observed source behavior                                                                      | Consequence for the reviewed design                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Composer `ChatView:2358`                        | Plugin query enabled at mount, independent of mention menu; query key includes thread ID      | Successful cache reuse is per key/window, not literally every click; failures/refetch/key changes cause additional requests |
| Client `providerDiscoveryReactQuery:401–419`    | Plugin query `staleTime:Infinity`; all-catalog invalidation exists                            | Infinity does not share across windows or remove thread identity; use explicit catalog ownership rather than a TTL tweak    |
| Composer command-menu hook `330`                | Only installed/enabled/default-installed plugins suggested                                    | Whole remote marketplace is not needed for current mention surface                                                          |
| CM discovery `2580`                             | Requires active thread context and matching cwd                                               | New-folder catalog needs independent account-process acquisition                                                            |
| CL commands `5343–5370`                         | Active thread, otherwise any active session; one cached cwd; global pending discovery promise | Cross-folder and cross-connection isolation must be proven before reusing this mechanism                                    |
| CL temporary commands `5303`                    | Uses `pathToClaudeCodeExecutable:"claude"` and SDK environment                                | Pinning installer alone is insufficient unless temporary discovery resolves the exact managed binary too                    |
| OpenCode inventory `1340`                       | Optional agents timeout produces successful empty list                                        | P25's absent-kind vs failed-kind distinction cannot be implemented by wrapping this old result unchanged                    |
| Updater `providerUpdateCoordinator:273`         | First install requests `version:"latest"`                                                     | Removing only hourly repeat would still leave untested first installs                                                       |
| Artifact resolver `managedProviderArtifact:119` | Supports GitHub latest or exact release-tag URLs                                              | Pinned installer callers must never pass latest; installer itself can remain                                                |
| `ProviderHealth:1455`                           | Separate 24-hour latest-release advisory worker                                               | Independent deletion from automatic installer                                                                               |
| `MANAGED_PROVIDER_ADAPTER_RELEASES`             | Fixed adapter/protocol labels, not exact CLI version pins                                     | Existing labels are not evidence of tested binary compatibility                                                             |

## 6. Evidence limits and planner review inputs

- This inventory establishes source call paths and the reproduced catalog-size
  failure. It does not claim a day of Production validation, memory-under-load
  measurements, or a completed ten-thread Dev switching test.
- Do not equate broad string-match counts with behavior counts. Tool names,
  protocol namespaces, display formatting, and provider retry telemetry are not
  independent retry mechanisms.
- Review OpenCode's credential/isolation boundary before changing its process
  ownership to one per Connection. The plan's shorthand differs from source.
- Review native background tasks, urgent interrupt routing, and stop/unsubscribe
  acknowledgment separately from ordinary `ensure` serialization.
- Specify treatment of non-lifecycle probe/install deadlines and descendant
  process inspection. The approved three lifecycle deadline categories alone do
  not describe these existing safety/diagnostic boundaries.
- For text-only SDK errors and rollout-file availability, the inventory does not
  assert an upstream structured field/event that has not been verified. The
  pinned-version contract audit must establish it or explicitly retain one
  version-tested boundary classifier, as P26 allows.
- P25's menu refresh/error UI remains planner-owned. This inventory creates no
  new UI, public RPC, runtime pin, release, or compatibility path.

P26 step 1 requires planner review of this evidence and an amended root plan
before step 2. No runtime refactor or Production installation is part of this
inventory commit.

## 7. Follow-up native and ownership evidence (2026-10-22)

These experiments are separate from the original source inventory above. The
root TODO remains the implementation authority.

### Shared OpenCode exit boundary

`1786fa643` exercises the pinned OpenCode 1.19.3 executable with two isolated
server profiles. Two sessions on the first server enter blocked upstream
requests; the second server has a live question awaiting an answer. A deliberate
SIGKILL of the first child produces its OS exit and rejects both of its active
HTTP requests. The second server retains its question, accepts the answer,
finishes that turn and accepts a later turn. Its process never exits.

A killed process cannot emit terminal native events after death. The native
boundary proved here is OS child exit plus failed requests, not a per-session
exit notification. Penkra must attribute that exit using its own exact process
membership. This experiment does not prove the future adapter mapping.

### Cancellation settlement is part of ownership

`ffa554c90` reproduces an adapter cancellation race using a manager whose abort
cleanup is held behind an explicit barrier. Before the change, `Fiber.interrupt`
returns while that native cleanup remains blocked. The corrected callback
finalizer waits for startup settlement and session teardown. A second test lets
startup return a ready session after abort: teardown still completes before
cancellation returns. A cancellation during managed-resume preparation is
checked before entering native startup. The shared account process is not
terminated by this cleanup.

All 37 tests in the changed Codex adapter file pass. This is controlled evidence
of the ownership mechanism, not proof that it caused a particular historical
Production stall. It does not by itself implement the ThreadRuntime owner or
change urgent routing.

### Connection-local usage protocol

The pinned Codex 0.163.0 contract now reads both native account methods through
an isolated app-server with externally supplied fixture credentials and a local
HTTP backend. `account/rateLimits/read` returns the fixture's remaining credit
balance (`"10"`, `hasCredits: true`). `account/usage/read` instead returns a
token-activity summary with `lifetimeTokens`; it is not the credits endpoint.
Its backend profile response requires `stats`, unlike the rate-limit response.

This distinction agrees with the generated pinned protocol types
`GetAccountTokenUsageResponse` and `RateLimitSnapshot`, and the official
[account and usage documentation](https://learn.chatgpt.com/docs/app-server).
The initial new test failed because the fixture returned the rate-limit shape
to the token-profile endpoint; giving that endpoint its own `stats` response
made the real native request succeed. This was a fixture defect, not a provider
or Production failure.

The pinned Claude CLI 2.1.307 / SDK 0.3.307 contract successfully calls
`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true})`
on its managed query. In this API-key fixture, session cost is numeric,
`rate_limits_available` is false, and `rate_limits` and `behaviors` are null.
That establishes a real callable native method and its no-plan shape, not
Claude subscription-account parity. The SDK explicitly labels the method
experimental; version pinning does not establish its behavior for later SDKs.

Neither experiment reads personal credential files or proves the application
usage wiring, multi-Connection account parity, or the personal-credential
isolation acceptance cases. No Production installation is part of this evidence.
