# Thread lifecycle evidence, September 7, 2026

This document records observations and executed reproductions. Active work is tracked only in
the ignored repository-root TODO.md. Coordinator: Thread
`9808159a-4c06-4c61-a4d9-028bd2fe15b4`.

## Evidence boundaries

User screenshots show composer/transcript overlap, including image attachments; a Thinking label;
and a sidebar spinner while a composer contains Continue and a send arrow. The user reports delayed
delete/edit/steer feedback and Claude activity appearing above an older compaction completion.
Screenshots establish visible coexistence, not elapsed click latency or provider acceptance.

The user clarified that New Deck's retained Continue at 05:02:26.791Z was a second send. It cannot
establish acceptance of the earlier click. No production retry was performed by this investigation.

## New Deck: cancellation and stale startup

Registered `penkra threads read` and `penkra diagnostics threads diagnose` for
`0fe3d49c-9f7c-47c6-84f0-3a59600d4a52` reported session `starting`, latest turn `queued`, thread
`working`, no last error, no delivery blocker, and no projection quarantine. The newest durable
event at that observation was 2605198. These are bounded observations, not proof of runtime work.

The registered events read with full payloads returned this sequence:

| Sequence | Event                    | Evidence                                                                       |
| -------- | ------------------------ | ------------------------------------------------------------------------------ |
| 2604653  | turn-start-requested     | Requested at 04:56:27.103Z                                                     |
| 2604654  | session-set              | Interrupted, activeTurnId null, at 04:56:29.186Z                               |
| 2604655  | turn-interrupt-requested | Names pending message 0f636edd-fcd8-49e2-a231-fa6bcd282809                     |
| 2604658  | session-set              | Starting; carries original 04:56:27.103Z timestamp despite following interrupt |
| 2604667  | session-set              | Starting, activeTurnId null, at 04:57:13.542Z                                  |
| 2604670  | session-set              | Starting, activeTurnId null, at 04:57:16.239Z                                  |
| 2604671  | turn-start-cancelled     | Same pending message; cancelledAt incorrectly carries original send time       |
| 2605197  | message-sent             | Second Continue, delivery queued, at 05:02:26.791Z                             |
| 2605198  | turn-queued              | Same Continue command/message 660d5cff-d9f0-4e64-b513-deb06d96c4ab             |

An isolated worktree at base `3bb3b8f90` reused the real reactor integration harness. The existing
pending-start cancellation scenario plus an assertion against a final starting session passed.
Adding a delayed session-set(starting) after the pending interrupt and before releasing startup
reproduced the contradiction: message removed, pending message null, latest turn cancelled, session
starting, activeTurnId null, lastError null. The invariant assertion failed at 05:12Z:
`expected 'starting' not to be 'starting'`. This reproduces the orchestration seam using controlled
session input, not an end-to-end provider/desktop run.

The inspected path is `completeCancelledTurnStart` in ProviderCommandReactor.ts: runtime stop then
cancellation event. Cancellation projections settle the turn/remove its message but do not settle
the session. `drainQueuedTurnsForThread` returns while session status is starting. A pending interrupt
already recorded as completed is skipped when its reactor handler runs.

## Two flyer failures

`420710cb-b3e4-4625-a958-f6a7da779af6` (Let's design a flyer for an) reported OpenCode 1.18.29
server startup exit code 1, empty stdout, and stderr `database is locked`. Diagnostics returned
session error but latest turn running. Start delivery event 2603372 was uncertain after one attempt.
No retained provider runtime events were available; global retention is bounded, so absence does
not establish that none occurred. The particular lock owner has not been established.

`5e032cd0-260a-484d-b162-1883bbb81155` (HerWebCraft Academy Canvas Flyer) reported
`Streaming response failed: [400] At most 4 image(s) may be provided in one prompt.` The original
user message was a text-only request to design and visually verify a flyer. Activity event 2603712
records turn failure and 2603714 runtime error at 23:45:22.807Z on September 6. The exact assembled
provider request and its image count were not retained by the diagnostics read.

Upstream reports describe OpenCode database locking with concurrent sessions, but these are leads,
not reproduction of this installation: [OpenCode issue 19521](https://github.com/anomalyco/opencode/issues/19521).

## Delayed queued-action reproduction

The coordinator executed a full Chromium ChatView fixture with an already-running turn, submitted a
queued follow-up, and held only the `thread.turn.start` acknowledgment. Each action was clicked twice
before releasing that acknowledgment. All three cases failed the single-dispatch assertion:

| Action                         | Commands observed after acknowledgment release |
| ------------------------------ | ---------------------------------------------- |
| Steer twice                    | Two `thread.turn.steer-queued` commands        |
| Delete twice                   | Two `thread.turn.cancel-queued` commands       |
| Edit twice, reopening the menu | Two `thread.turn.cancel-queued` commands       |

The initial withheld interval emitted no action command; the handlers await the same pending
admission before taking action ownership. This is a browser/command-boundary reproduction of
duplicate intent, not a measured account of the latency in the user's screenshot. Three tests
failed, seventy-five were skipped. The retained fixture is in the task's `queue-repro` worktree.
Teardown failure screenshots are not used as visual evidence.

## Test-coverage distinction

The existing quick-stop UI path restores a draft upon interrupt command acknowledgment, while a
separate cancellation event handles optimistic transcript cleanup. The existing pending-start
reactor test verifies message removal and runtime stop, but originally did not assert terminal
session state or subsequent queue progress. Passing those checks did not establish the missing
invariants.

The UI worker subsequently executed a Chromium test with a prompt/image, held start acknowledgment,
and Stop. Its DOM/store assertions found both restored composer content and the optimistic
transcript row. Injecting cancellation through the normal sync stream still left the row. The
focused test failed with `expected <div data-message-id=...> to be null` (one failed, 75 skipped).
The coordinator opened the worker-supplied failure screenshot and found it blank; that screenshot
is not accepted as visual evidence. The executed DOM/store assertions are the reproduction evidence.

## OpenCode media history reproduction

The provider worker ran the actual upstream 1.18.29 darwin-arm64 binary against a loopback-only fake
OpenAI-compatible provider. The fake model called the real `read` tool on task-owned PNGs. The
initial prompt was text-only. The fake provider enforced the observed four-image ceiling.

The coordinator independently inspected the recorder and captured JSON. Tool-loop outbound image
counts were `0,1,2,3,4` for the successful control and `0,1,2,3,4,5` for the failure. The final failing
request contained five historical synthetic user messages, each carrying one image. Thus the
accumulation occurs inside the native tool loop; limiting initial Penkra attachments alone cannot
prevent it. This demonstrates the mechanism, not the unavailable exact production request.

Captured control SHA-256: `2f1b5609b97f5f5ff374b43a90d23aab2ff35208e8f5a21312a489943632ae2a`.
Captured failure SHA-256: `62386dc86bdaf2fd2bcb235f31f65dfb8fdc9d33dc11e1e705c25173035aba75`.

Version-matched [OpenCode message conversion](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/session/message-v2.ts)
retains eligible tool attachments and converts extracted media into synthetic user content for
compatible providers. The upstream assembler owns these internal requests.

The coordinator also inspected version-matched
[compaction code](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/session/compaction.ts).
Its pruning path skips the latest two user turns and budgets older completed tool outputs by
estimated text tokens. The documented [compaction settings](https://opencode.ai/docs/config/#compaction)
describe context/token management. These are not evidence of an image-count admission check.
Enabling pruning therefore cannot be claimed to prevent this same-turn media accumulation; no
production compaction setting was changed.

## Gateway creation observation

Request `lifecycle-newdeck-repro-20260907` failed selected-model verification after retaining idle
Thread `agent-8af8b7084ff0d9d9a4a3f2d15a825272`. Retrying the same inputs/request ID returned a
thread-create command identity collision. Sending into that empty Thread was also rejected because
the first message requires an exact model and binding revision zero. It never started a worker.
A distinct implementation task, after the parent reproduction, successfully started as
`agent-7d5829304970a78077eaea2d7f9fb469`.

The coordinator then executed the real creation coordinator with identical caller/request inputs
at clocks one second apart, comparing actual `fingerprintOrchestrationCommand` results rather than
only deterministic command IDs. The regression failed: the same command ID carried different
fingerprints because each invocation generated a new `createdAt`. Existing synthetic retry coverage
accepted both dispatches in its mock. This reproduces payload drift; it does not establish a safe
repair by excluding timestamps from the global fingerprint contract.

## OpenCode cold-start contention reproduction

The same verified 1.18.29 binary was launched in twenty pairs against task-owned cold databases.
With one shared database per pair, every pair lost one process: nineteen schema-creation failures
and one exact `database is locked` failure. Twenty pairs using distinct databases produced forty
ready processes and no early exits. The coordinator independently inspected the matrix and the
exact lock stderr. No lock was injected. All sixty surviving fixture processes were stopped by
their recorded PIDs.

Matrix SHA-256: `1cb30607517c0567e85f3d4f9ce9cefc5c0707d26130bb88fb9dc9a09d4fb595`.
Exact lock stderr SHA-256: `b87536f90822e4ad7756c96ea345835a34ce7864070dfad2d0bca776b734024e`.

This is a native-runtime reproduction, not proof of the original lock owner. Penkra's ordinary
pooled startup holds one runtime-instance mutex until readiness. Different working directories can
select distinct processes sharing native state, but that alone does not prove overlapping cold
startup in one backend. The follow-up serve/model-discovery experiment did not complete: provider
Thread `agent-8dcd91ceae3f427d769befc9a8525de9` stopped with a provider cybersecurity flag. No result
is inferred from that interrupted task.

## Desktop validation boundary

The coordinator integrated the reviewed initial cancellation/generation changes and independently
ran 276 server tests plus 43 web reducer tests successfully. The later immutable gateway admission
patch passed 74 integrated gateway/repository/migration tests. These counts describe those specific
checks, not completion of the investigation or validation of later unintegrated changes.

A fresh standard Penkra Dev 30 instance was launched for this investigation. Native window
inspection returned `osascript is not allowed assistive access (-1728)`. Launching the app alone
does not satisfy desktop flow validation. Browser DOM regressions and server tests are separate
evidence; no successful native interaction is claimed.

## Failure-boundary evidence

The reactor fixture with `startSession` failing before readiness invoked `sendTurn` zero times.
It marked the message failed and session error, but left the canonical logical turn running with
null start/completion/provider-turn fields. The added assertion failed. A separate queued-successor
control advanced and accepted the successor, so inspecting only the latest turn after that advance
would hide the failed attempt. These are distinct from failure after provider acceptance.

Retained parent activity `2604663` in turn `01a07a39-9773-7492-b4cb-f7706d31b2e7` records the actual
usage-limit message at `2026-09-07T04:56:34.205Z`, normalized as `class: provider_error`. The bounded
diagnostic detail does not establish which upstream machine-readable error fields were supplied.

The official [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
documents structured `codexErrorInfo`, including usage-limit and transport categories. Local
`CodexAdapter.ts` normalizes fatal error notifications as generic provider errors while preserving
raw notification detail; request errors only promote the pending-interaction-not-found code.
Thus upstream structured evidence and normalized lifecycle classification are separate boundaries.
No quota policy or retry rule was derived solely from an English error string.

## Mixed-sequence work-log reproduction

The coordinator executed `deriveWorkLogEntries` against all six permutations of three fixture
activities. Two tool rows carried sequences 1 and 2 but timestamps 00:00:03 and 00:00:01;
a compaction row carried no sequence and timestamp 00:00:02. The resulting order varied across
the permutations. Input `[sequence-2, unsequenced, sequence-1]` remained in that order, violating
the ordering between the two durable sequences. A retained assertion script exited 1.

The comparator uses sequence when both rows have it and timestamp otherwise. With mixed evidence
that relation is not transitive, and the already-ordered fast path can accept a globally inconsistent
sequence. This is a deterministic isolated reproduction, not yet attribution of the user's specific
Claude incident; the exact affected Thread remains unidentified. No ordering implementation was
changed on the basis of an assumed provider event stream.

Code review found separate ordering rules: `workLog.ts` and `storeNormalization.ts` compare two
available sequences before timestamps but use timestamps for mixed pairs; shared `threadSummary.ts`
substitutes `MAX_SAFE_INTEGER` for missing sequences; the inspected snapshot activity query orders
by creation time before sequence presence/sequence. These are code facts, not proof that every
difference caused a visible incident. A correction needs to distinguish durable causal position,
legacy rows with missing evidence, and unsent optimistic rows rather than use one clock fallback
without establishing its meaning.

## Lifecycle boundaries exposed by the reproductions

These distinctions explain why a successful command or a green focused test can coexist with the
reported UI defects. They are review criteria, not a claim that every implementation satisfies them.

| Boundary                      | What its evidence establishes                      | What requires separate evidence                                          |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| Send/Stop command receipt     | The host accepted that command identity and intent | Provider acceptance, cancellation completion, or rendered UI convergence |
| Message delivery accepted     | The provider accepted the message                  | Successful execution or available quota for the remainder of the turn    |
| Runtime stop completion       | The adapter stop call completed                    | Drainage of already-published downstream events                          |
| Session state                 | A runtime/session observation                      | Ownership by a particular pending message or provider generation         |
| Bounded transcript snapshot   | The rows included at its projection frontier       | Absence of a message elsewhere in the durable transcript                 |
| Cancellation completion       | The named pre-acceptance attempt was cancelled     | Permission to clear a successor's pending identity                       |
| Sidebar or Thinking indicator | A UI derivation of its input state                 | Proof that a provider is currently executing                             |

The reviewed cancellation changes exposed both an unbounded client cancellation map and a proposed
ingestion predicate that checked current startup presence without correlating the incoming event.
Neither proposal was accepted as an architectural solution on that evidence. Tests must cover lost
deltas/full hydration and a late old event arriving while a successor legitimately starts, as well
as the originally failing interleaving.

The worker subsequently discovered that its added reactor test did not run the runtime-ingestion
path for `session.state.changed`. Its claimed post-cancellation ingestion coverage is withdrawn.
The passing assertion was vacuous; the valid late-start reproduction still uses an actual engine
session dispatch before cancellation completion. Whether an already-published provider event
recreates the state through the real ingestion service requires its own positive-control test.

## Cancellation outcome recovery review

The integrated recovery path treats an interrupt command receipt as intent, not positive
pre-acceptance cancellation. An exact `(threadId, messageId)` lookup joins the canonical turn
and exact delivery row in one transaction with the projection frontier. A bounded transcript
page cannot prove cancellation by absence. Ambiguous identity, unknown state, and an uncaught-up
projection do not restore. Accepted delivery vetoes a contradictory cancellation row.

The browser review reproduced an additional query race: a prior lookup rejected after a new
lookup began, clearing the newer identity and losing its cancelled result. The original
`lookup-stale-rejection` Chromium assertion failed with an empty draft instead of the original
prompt. Identity-fenced rejection cleanup passed that case and the hydration, remount, and
newer-draft controls (4 passed). The integrated SQL/index/migration checks passed 37 tests;
47 reducer tests passed. A first integrated full ChatView browser run failed before test import
(`Failed to fetch dynamically imported module`), so it supplies no product-flow acceptance.

Recovery records survive React remounts in renderer memory. They do not survive a full renderer
restart. Native desktop QA remains unperformed because the OS denied Accessibility access.

## Canonical activity sequence loss and diagnostic omission

The actual canonical operation ingestion fixture produced accepted touch receipt sequence 8,
while `thread_activities_read.sequence` returned NULL for the same operation. The independent
assertion failed (`expected null to be 8`). Migration 138's view explicitly projects NULL for
operations and notices, whereas live `thread.activity-read-model-updated` delivery attaches the
orchestration event sequence. Thus hydration changes the available ordering evidence.

A separate diagnostic fixture inserted one canonical notice at sequence 100 and one unknown-order
notice. `ThreadDiagnosticsQuery.getActivityCoverage` returned high-water 0 and unknown count 0,
instead of 100 and 1. Its source is the legacy projection table, while the UI reads the union view.
The failure was observed after correcting the isolated fixture's parent-table setup; a prior
foreign-key setup error is not counted as a reproduction.

The Strategy Thread's inspected compaction activity page was complete for that kind and had no
unsequenced projection rows. Its last compaction was sequence 2603234, turn
819f858f-ad91-47ef-b56f-e5cd07ada5f3. Two paginated activity reads for that exact turn returned 69
legacy projection rows and no tool kinds. This does not establish that the UI had no tools:
canonical operations were outside that diagnostic source. Strategy has not been confirmed as
the user's exact Claude incident.

## Combined queued-action and cancellation checks

The integrated ChatView Chromium suite passed 93/93 using the task-owned isolated-cache harness.
That run includes the cancellation outcome matrix, stale request rejection, delayed repeated
Steer/Delete/Edit, navigation, and queued-action rejection/retry cases. It is browser evidence,
not native Penkra Dev acceptance. The earlier import failures remain recorded above; their exact
cause was not established, and no product source was changed to hide them.

The queued-action registry claims exact Thread/message ownership synchronously before admission
waits. Cancellation recovery uses the current draft store at completion. If newer composer content
exists, recovered content remains an explicitly paused editable row with old admission metadata
removed. The controlled active-to-idle transition emitted no second start for that recovered Edit.
The integrated ownership, queued-dispatch, and composer-draft tests passed 37/37.

The integrated ordering checks passed 69 web tests across work-log and store normalization.
The server run passed 121 tests and failed one legacy-lineage migration replay with a duplicate
`presentation_sequence` column. The migration now checks column existence and only backfills NULL
sequence fields. The 19 migration checks then passed, and a separate replay-after-receipt-retention
control passed. Runtime ingestion/diagnostic behavior had passed in the original 121-test set.

The ordering guarantee is deliberately limited: known orchestration sequences retain global causal
order through activity derivation and the final message/work merge. Historical rows with no exact
ordering evidence retain their category positions and use legacy ordering among themselves. This
is not a claim of a fully known chronology for unsequenced history.

## Recovery RPC registration and Dev startup

The fresh Dev30 launcher log recorded repeated backend startup failures at the Effect RPC handler
registration boundary (`Cannot read properties of undefined (reading 'key')`). The added
`orchestration.getPendingStartOutcome` handler and legacy WebSocket schema existed, but its Effect
RPC was missing from `WsFeatureRpcGroup`. A parent-owned contract test reproduced the exact
exception before the registration fix. The corrected RPC/legacy WebSocket tests passed 7/7.

After the correction, Dev30 recorded `http-runtime.start` completion and `Penkra running` at
2026-09-07 01:05:37 MDT. It subsequently reported account-auth fetch connection refusal and shut
down at 01:05:58. This establishes backend startup recovery, not completed desktop-flow QA. A
fresh attempt to read native window names still returned macOS assistive-access denial (-1728).

## Recovery ownership registry review

Three renderer-memory maps were replaced by one exact Thread/message registry. It coalesces
lookups to one in flight with a bounded pending follow-up, uses the current remounted callbacks,
and retains unresolved payloads after transport failure. Accepted delivery, definite failure, and
confirmed Thread deletion release ownership; unknown outcomes do not. Push and lookup cancellation
share the same restoration settlement.

Parent review exposed synchronous reentrancy before that settlement claim was installed. The
worker's regression observed two restorations before the correction and one after it. A separate
browser control reproduced an early return when the selected connection disappeared while a newer
prompt/image existed. Restoration now reports explicit success: a failed attempt retains the
original recovery owner. The connection-return/later-trigger control restores the original while
preserving the newer draft separately. These are controlled browser/registry results, not proof
of renderer-restart persistence.

The RPC registration audit now checks every declared orchestration schema against the feature
transport group (21 RPC tests passed). A mock NativeApi or isolated SQL query cannot prove that
the real transport starts and exposes its handler.

The integrated registry/draft/queued-ownership unit run passed 43/43. The parent-owned Chromium
run passed all 12 selected pending-start cases (82 unrelated cases skipped from the 94-case suite),
including the newer connection-loss control. This supplements the earlier full 93-case run; it is
not a new full-suite or native acceptance claim.

## Returned terminal turns and acceptance settlement

The controlled Codex protocol fixture returns a `turn/start` result whose turn is already failed,
completed, or interrupted. The manager now routes that returned terminal state through its existing
terminal-notification handling instead of unconditionally restoring `running`. Already-observed
terminal IDs also fence a late in-progress result and duplicate terminal notification.

Real journal/ingestion/reactor fixtures reproduced three additional interleavings: terminal before
result binding; a live successor present before/during restart's running write; and terminal arrival
while accepted-delivery admission is held. The corrected reactor preserves the exact successor,
uses conditional session admission, and reconciles exact terminal state/completion time after
acceptance when needed. Delivery remains accepted. This is process-local observation plus durable
reconciliation, not a claim that every crash/restart window has been eliminated.

Parent review found that SQL consumed the new terminal fields while the in-memory and web reducers
did not. Both live reducer controls reproduced a still-running logical turn. They now settle the
exact matching running logical turn and preserve a different successor. The integrated web reducer
suite passed 47 tests. Parent's independent manager/adapter suite passed 153 tests with two skipped.

A further parent fixture found an invented `startedAt` after the already-observed `completedAt`: the
accepted-delivery projector was using its receipt timestamp as an execution start. That fallback was
removed. Runtime start/running events establish start time; delivery establishes binding. The broader
combined run initially passed 332 and failed two accepted-binding settlement tests because settlement
had used non-null start time as its eligibility proxy. Settlement now recognizes an accepted provider
binding without fabricating a start timestamp. The reactor/pipeline rerun passed 166/166, including
early-terminal, terminal-during-admission, real-start timestamp, native-steer and restart controls.

## Integrated verification findings

The first workspace pass completed formatting and passed lint, but formatting verification found
one retry test file needing a second targeted format, and type checking rejected incomplete service
and message fixtures. Fixture corrections use the actual service error signatures and required
nullable identities; they do not suppress assertions. The affected gateway/startup/reaper suite
passed 89 tests after those corrections.

Type checking also exposed a real live-state error: the L5 web handler compared normalized session
`status` with `starting`. A real normalized starting session has `status: connecting` and
`orchestrationStatus: starting`. The old L5 fixture incorrectly used a raw server status in the
renderer shape, so its prior passing assertion did not establish this live behavior. With the valid
renderer fixture, failure left the session connecting and the visible error empty. The handler now
uses the canonical orchestration status and updates normalized status, orchestration status, and
the visible error together for the exact owned pre-dispatch failure.

A separate sidebar assertion, seeded through a real starting-session event, reproduced the summary
remaining running/connecting while transcript state became terminal. Lifecycle-bearing delivery
events now refresh the sidebar summary. An initial sidebar attempt lacked a seeded summary and is
not counted as a product reproduction. The corrected reducer/normalization run passed 52/52.

Canonical diagnostics now retain explicit bounded machine-code provenance and retry booleans for
the reproduced provider-error shape. Parent review rejected truncating a machine identifier into a
different value: oversize codes are omitted; shortened diagnostic prose is marked explicitly. The
integrated normalizer/activity/ingestion suite passed 123/123. These fields are evidence, not a new
retry, quota-reset, or queue-resume policy.

The final combined server run across all 16 changed server test files passed 540 tests with two
skipped (542 total). This includes the integrated admission, cancellation, startup, terminal-result,
projection, migration, diagnostic, and service-fixture changes. It does not include native desktop
acceptance or the still-separate composer preflight work.

A later native-window access check again failed: System Events returned `osascript is not allowed
assistive access` (-25211). No native UI interaction was performed by that check.

A second fresh Dev30 launch completed `http-runtime.start` and reported `Penkra running` at
02:14:47 MDT, using the isolated slot-30 root and port 54475. The launcher also reported a
DevTools HTTP port collision. Backend startup is observed; native account and affected UI flows
were not manually exercised. The migration-lineage command passed across 119 release tags
(`v0.0.16` through `v0.12.2`), preserving every released migration identity.

## Generation ownership at the write boundary

A parent-independent run of the real journal/SQL ingestion fixture passed the positive
current-generation control and reproduced two failures (1 passed, 2 failed, 99 skipped).

The first fixture holds the actual session command after ingestion validates generation A,
commits generation B and its running successor, then releases the old command. The successor's
`running` state, turn identity and `01:01:01` session update timestamp were replaced with
A's `starting`, null active turn and older `01:01:00` timestamp. The raw journal retention assertion
passed before the session-state assertion failed. An earlier attempt deadlocked its own startup
replay; the corrected run uses concurrent startup, a bounded gate and finally-based release, and
fails on the state mismatch rather than a timeout.

The second fixture journals an unbound `runtime.error` while A is current, then installs B before
starting ingestion. Both raw retention and visible activity assertions pass. The replayed error
nevertheless changes B's running successor to `error`, clears its active turn, and installs A's
older timestamp and error text. This is not an already-stale live emission: the event was valid
when it entered the journal.

ProviderService's lifecycle mutation lock and per-Thread binding-write lock do not enclose the
separate ingestion consumer's generation read and later orchestration command. Journal ordering
serializes journal events with each other, not an independent generation writer or successor
command. Generation checking before dispatch therefore does not establish atomic ownership of
the resulting state write. Retaining diagnostic history likewise does not grant an old error
authority to settle a replacement run.

## Composer preparation and captured submission ownership

The integrated composer now claims renderer-memory submission ownership before attachment loading
or Connection refresh. It captures the original payload, preserves a newer draft, and keeps Stop
and Thinking feedback through remount and a held dispatch receipt. Active preparation and an
already-dispatched Stop target have separate lookups, so a newer preparation cannot hide the older
message identity.

Controlled browser interleavings cover repeated Send, Send after cancelling a still-held
preparation, delayed image hydration, background hydration completing after send ownership is
released, navigation/remount, delayed dispatch failure, and an accepted server outcome vetoing
restoration. An unchanged stopped draft retains its persisted attachment and has no duplicate
paused row. Stop on an active run keeps its queue paused through late follow-up preparation and
the active-to-idle transition. Recovery uses the existing exact-outcome callback when available
and retains its unresolved-result behavior.

Parent review corrected typed fixture construction and made the late background-image assertion
wait for the read to return before the next frame. An additional parent assertion reproduced Stop
during image hydration retaining content but losing an explicitly selected Connection: expected
`connection-codex-browser`, received null. Known Connection intent and provider options are now
captured before the first await; later admission resolution augments the same snapshot. The first
attempt to add that assertion used an incorrect fixture path and ran the unchanged test; that pass
was not counted as reproduction evidence.

The parent-owned integrated unit/reducer/work-log run passed 158 tests. The combined Chromium run
passed all 105 ChatView cases after the final Stop/Connection correction. Web type checking passed
before that final small snapshot correction; final workspace verification is recorded separately.
These are automated browser results. Native desktop flow acceptance remains unverified.

## Luna assignment creation failures observed during investigation

The registered gateway returned the following sequence on 2026-09-07 while assigning
GPT-5.6 Luna with `reasoningEffort: high` on the same explicit Codex Connection
`8dcea2ed-d8f5-460b-8ca6-616d4236634f`:

1. `threads.create`, request `lifecycle-luna-high-ui-recovery-20260907`, retained
   Thread `agent-d8b5e480cc31d8313aa33ef0e187dad4` but returned
   `Could not verify the selected model for this Connection.`
2. Retrying the identical request identifier and input returned
   `Command identity collision (agent:d8b5e480cc31d8313aa33ef0e187dad4:thread-create):
The command ID is already bound to different command content.`
3. A registered read returned that exact Thread idle, model `gpt-5.6-luna`,
   no messages and null lastError. This did not establish successful admission.
4. Sending its initial brief through `threads.send` returned
   `The first message requires an exact model and binding revision 0.`
5. An explicitly separate replacement request
   `lifecycle-luna-high-ui-outcome-replacement-20260907` created
   `agent-af72e91d3fdba6ee4bcaf143e1ae62fc`; the subsequent registered read
   returned working/running with the initial prompt delivered. The original
   retained Thread had no executed work; no duplicate owner was started.

The replacement is an operational workaround, not a repair or proof of the
original model-verification cause. The retry collision matches the existing L10
incident class, but this sequence has not yet been replayed against the local
immutable-admission changes. No live database repair, account substitution or
production code change was performed. The binding-revision rejection remains a
separate observed boundary failure; its intended API contract and recovery path
are not established by a successful replacement.

Source inspection narrows, but does not establish, the initial cause:
`ProviderTurnSelectionResolver.resolveManagedSelection` wraps a failed
`adapter.listModels` call with the exact model-verification message above. The
separate missing-model branch follows successful catalog retrieval. Therefore
the returned message alone does not establish that Luna was absent from the
catalog. The underlying catalog-call failure remains unavailable in this
observation. `ProviderThreadSwitchCoordinator` rejects first-turn dispatch when
there is no harness binding and either binding revision 0 or exact model selection
is absent; this explains the checked admission condition, not why the gateway's
recovery surface left that condition unsatisfied.

## Atomic generation guard integrated after independent Luna review

The independent Luna High lane reproduced the pre-guard read-to-dispatch race:
generation A replaced generation B's running successor with starting/null active
turn and the older timestamp. The reviewed guard passed 142 server ingestion,
engine and projector checks, 48 web reducer checks, and 21 contract RPC checks.
The reviewer corrected the dispatch Deferred result type and a web fixture's
nullable error field. Package typechecks failed in both isolated baseline and
review trees; complete compiler logs remain under the task scratch
`luna-generation-typecheck-evidence`. The web outputs matched after path
normalization; server error-code counts matched with the recorded harness-line
shift. Those failures do not substitute for a passing final workspace check.

Parent patch applicability initially failed at ProviderRuntimeIngestion.test.ts
line 7180. Removing a temporary baseline reproduction had left one extra blank
line. The baseline was restored to exact main bytes, leaving guarded review
regressions intact. The regenerated nine-file patch passed applicability checks.
Parent verified each main baseline SHA and reviewed-source SHA, backed up the
files, applied the patch, and verified every resulting SHA matched the manifest.
No identical-source test batch was repeated. The reviewed implementation is now
in local main, with no commit or production release.

The guard uses a conditional writer-boundary update inside the engine transaction;
skips receive a state-neutral durable event and receipt. Tests cover stale and
current generation writes, null-session skip, replay after generation changes,
legacy accepted receipt replay without recomputed-payload collision, unguarded
result compatibility, explicit historical-turn finalization, current unbound error
finalization, and buffer preservation across skipped exit. Multi-process behavior,
universal crash recovery and native desktop acceptance remain unverified.

## Investigation execution errors and evidence limits

The Luna UI lane initially imported zero browser tests after a Vite dependency
scan/dynamic-module failure. Installing its frozen-lockfile dependency set in the
isolated lane allowed 105 browser tests to pass. This establishes an operational
recovery, not a definitive root cause for every prior import failure. Its root
README was accidentally overwritten while adding scratch retention information;
the captured README was byte-restored and the note moved to RETENTION-README.md.
Neither error was treated as a product regression result.

The provider failure lane's first integration run rejected fixture folder creation
with a physical workspaceRoot. After fixture correction, a bounded run stalled
after the first provider request and timed out before successor/recovery
assertions. These runs do not establish the proposed ingress classification
defect. An earlier four-record fixture recorded a different durable order from
emission; without controlled emission/callback/persistence ordering evidence,
that observation does not establish a production causal-order defect.

Older queued parent guidance reached a worker after newer instructions superseded
it, resulting in unnecessary setup/handoff activity. Parent consolidated the
current assignment explicitly. This is an observed orchestration inefficiency,
not proof that FIFO delivery itself is defective. A parent source search also
failed because zsh expanded an unmatched deferred-file glob; a corrected literal
path search succeeded without changing source.

## Queued-action receipt frontier integrated

The Luna UI lane captured the original ownership module from its staged main
baseline (Git blob 49121b2d9f19f2d991ba66fa37fc06c7ba62650c). Its controlled
accepted-action/omitted-snapshot assertion failed: the accepted set became empty.
The reviewed implementation stores the command receipt sequence and releases
accepted ownership only for a matching-or-newer delivery or cancellation event,
not absence. Older-sequence and matching-sequence positive controls were added.
The lane reported 105 ChatView browser checks and 154 focused ownership, registry,
projection and work-log checks passing on the reviewed source.

Parent checked four main baseline and final source Git-blob hashes, checked patch
applicability, backed up the files, applied the patch and verified all final hashes.
Files: ChatView.tsx, queuedComposerActionOwnership.ts, its test, and
storeProjection.test.ts. The added projection fixture covers 120 messages and 13
work rows across live/full and paginated hydration. It preserves sequenced causal
order and presence of a sequence-less legacy compaction; it does not prove a
unique position for that legacy row or the full spinner/error/pending UI matrix.
No native desktop acceptance, production repair or release is claimed.

The same lane verified that a rejected desktop journal write rejects the existing
durability acknowledgement promise. A separate retained restart test persisted
post-send draft state, reloaded modules and hydrated it, then failed to restore
original direct-send content on confirmed cancellation because recovery identity
and payload were not persisted. This is controlled module/storage evidence, not
an Electron process-crash acceptance run.

## Monitoring interruption and returned handoff scope

Parent ended a turn after integrating the guard/frontier fixes while three
implementation Threads remained active. That stopped parent polling until the
operator explicitly challenged the gap. On resumption, gateway and provider
recovery handoffs had arrived, and UI persistence work remained running. Parent
resumed polling and returned incomplete handoffs for exact boundary coverage.

The provider fixture used a custom ProviderAdapterShape that manufactures
normalized events; it exercised real ProviderService, journal and coordinator
replay, but not actual CodexAdapter mapping. Its emission and callback arrays were
written in the same emit function, so they are not independent callback-entry
evidence. The injected opaque `usage_limit` field does not establish the upstream
Codex classification. The gateway fail-once catalog test asserted zero engine
commands on failure, placing it before child creation; the live failure happened
after a child was retained. A separate real-coordinator unbound-send rejection
control does not close that integration seam. These narrower findings remain
useful, but the full-sequence claims were not accepted.

## Retained-Thread catalog failure and immutable retry: real integration

The final regression uses real creationCoordinator, OrchestrationEngine,
ProviderThreadSwitchCoordinator and ProviderTurnSelectionResolver over in-memory
SQLite. The adapter catalog fails once with a typed ProviderValidationError after
thread.create is accepted. The returned error contains the observed wrapper
`Could not verify the selected model for this Connection.` The child remains
durable and unbound, with no turn receipt or accepted turn event. Retrying the
same request at a later clock with default Connection B reuses the stored
Connection A plan and produces one child creation, one binding and one accepted
turn. The focused test passed. Parent verified the patch and source SHA-256 and
integrated the one new test file without changing product code.

The test retains its injected cause in a fixture variable; this does not prove
that the original live catalog cause is available to operator diagnostics. That
original cause remains unknown. Initial fixture failures (duplicate profile_ref
and incorrect Effect service acquisition) were corrected; a successful but empty
catalog control was replaced by the required failed catalog call before acceptance.

After completion, an obsolete queued assignment attempted to restart the same
work. Parent explicitly interrupted that exact turn and the obsolete guard notice
and issued one current turn-race investigation. The retained regression and prior
artifacts remain frozen.

### Independent recovery review and baseline audit (10:46 UTC)

Luna reviewer `agent-977f45231ed13133b8e36fb19e789dd3` reported that fresh ChatView hydration registers unresolved recovery entries without requesting an outcome because their frontier remains null. The review also identified missing durable failed settlement, dropped cancellation sequence, retained restored records after acknowledgement, and incomplete durable-write failure handling. These are review findings awaiting the UI owner’s targeted reproductions and corrections; restart recovery has not been accepted. The reviewer actually ran `lifecycleRecovery.red.test.ts`: one failed and one passed. Consequently the prior nine-file/190-test green claim is not accepted as evidence of the final source state.

Parent independently compared provider lane baselines: ProviderRuntimeIngestion and projector match main, but the engine Layer SHA differs (main `e333b67516391b5797fab768312654554682106d1e128ebc2536de5ae7b69236`, lane `666dcf43a1d2ebfca86e2ccfa609223df05d1cf6f82588d808b739f0f635cde8`). The addendum also labeled the engine Service hash as the Layer hash. Provider test integration is withheld until the discrepancy is explained and its evidence corrected.

### Corrected provider boundary evidence integrated (11:00 UTC)

The final two provider test files were integrated after parent SHA-256 verification of both test sources and all nine accepted generation-guard baseline paths against current main. The corrected worker run passed two files/four tests. `providerAdapterFailureBoundary.integration.test.ts` uses the real CodexAdapter, ProviderService, SQLite journal, ingestion/projector and reactor, with a controlled manager notification source. It verifies normalized usage/auth failures and exact queued-message steer failure across offline restart without a second send or Connection substitution. It does not run an upstream provider process.

`providerRuntimeEventConcurrentOrder.characterization.test.ts` characterizes the real event pump using controlled producers and a held synthetic persistence callback; its completion array is in memory and is not SQLite durability evidence. No ordering or failure-policy product fix follows from these passing controls. The former DESC-read interpretation and stale engine baseline claims are withdrawn. The two earlier custom-adapter fixtures remain scratch evidence, not accepted substitutes for this boundary.

### Failure coverage audit and test type corrections

The read-only L7 audit distinguishes real adapter/SQLite evidence from existing mocked reactor coverage. At audit time, the accepted real-boundary fixture did not cover pre-acceptance structured failure, quota with a queued successor, session exit with queued work, transport-only send/steer failure, or retryable-warning queue ownership. Usage snapshot parsing tests establish credits/balance data, not a turn-failure or automatic-resume policy. These are coverage gaps rather than reproduced product defects.

A main server TypeScript check subsequently reported seven errors in the newly integrated test fixtures. The provider owner corrected its private `sessions` collision by using `controlledSessions` and declared the callback fixture helper’s real `Error` channel. The same two main test files then passed four tests (05:05:57 MDT, 2.78 seconds). The retained-Thread test’s adapter-error type and Option narrowing require a separate correction; an initial Option.getOrThrow patch incorrectly retained `.value` accesses and was rejected in review. A passing unpatched main runtime test does not validate that isolated patch.

### Turn ownership fence integrated

Parent integrated the seven-file Luna turn fence after verifying each main baseline SHA, lane final SHA and both patch hashes, performing read-only apply checks, and verifying every resulting main file. Real ingestion/engine gate reproductions had shown cross-generation and same-generation start overwrites plus an equal-timestamp completion overwrite. The worker final focused run passed 17 ingestion controls, with one web reducer and one server projector parity control passing separately. The additive skipped-write payload identifies generation/session-ownership mismatch, captured null and observed ownership. No migration or persisted command fingerprint change was made.

The separate retained-thread correction now uses the adapter error contract and correctly unwraps Option before accessing the shell. Its isolated runtime check failed before the test body in nested Effect scheduling; the earlier main pass was unpatched and does not validate the correction. Integrated main validation is handled separately. The isolated guard TypeScript log contains 496 diagnostics after five introduced nullability errors were fixed; the seven-error main log is a different baseline. Subtracting the totals does not establish an exact cause for every additional diagnostic.

The integrated main ingestion file subsequently passed all 115 tests and the corrected retained-thread test passed one test. The stale-terminal delivery-policy control now finishes B’s buffered item and asserts exact text and non-streaming state, so absence during buffering cannot hide dropped input. These runtime results do not replace the final workspace typecheck or native acceptance.

### Expanded offline provider matrix integrated

The reviewed matrix expansion passed ten tests across the real-adapter SQLite fixture and the separate synthetic pump fixture (05:38:22 MDT, 5.68 seconds). Parent integrated only the expanded provider test file after computing the nine baseline hashes and verifying both lane test hashes and the prior main hashes from the existing integration record. The worker’s report initially retained seven stale baseline hashes even though actual files matched main. A parent precheck also used an incorrect literal hash and stopped before any mutation; the corrected precheck read the exact hash from the prior recorded manifest.

| Controlled case                                                           | Observed durable behavior                                                                                                                                |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structured usage notification with rejected send before client acceptance | Command delivery remains uncertain, message delivery failed, exact canonical turn unstarted/running and lookup pending; one send across offline restart. |
| Usage-limit event with queued successor                                   | Successor remains queued without provider admission in this fixture; no automatic-resume policy is inferred.                                             |
| Session closure with queued successor                                     | Exact successor is accepted after closure; queued=true retains its historical queue origin.                                                              |
| Transport-only send failure                                               | Uncertain command remains blocking and exact pending recovery remains retained; no second send after restart.                                            |
| Transport-only steer failure                                              | Exact message fails while command acceptance remains uncertain; pending-start lookup remains unknown and no second steer occurs after restart.           |
| Retryable warning with queued work                                        | Running predecessor and queued successor remain owned; warning is retained without duplicate request.                                                    |

The first five failed expectations were fixture assumptions. The later claim that differing command/message labels proved a contradiction was withdrawn after reading the separate field contracts and persisted state together. No product defect or policy change follows from this matrix. It does not exercise upstream provider processes, actual credits exhaustion, native UI execution indicators or callback saturation. Those boundaries are not established by the passing offline tests.

During gateway provenance review, a parent search first used the wrong ProviderThreadSwitchCoordinator directory and returned no-such-file. `rg --files` located the actual orchestration Layer; the corrected read proceeded with no source mutation. A reviewer’s direct collaboration call also rejected a Penkra Thread ID because it belonged to a different agent-addressing system; subsequent internal coordination used Penkra’s registered Thread command. Neither tooling error is a product reproduction.

### Gateway catalog-cause provenance loss reproduced

A temporary observation in the actual retained-thread fixture showed that the gateway returns only `cause: "Could not verify the selected model for this Connection."`. The nested controlled ProviderAdapterValidationError (`operation=listModels`, `issue=controlled fail-once catalog`) survives in memory but is not present in that returned payload. The reviewed creation failure path does not write it to operational diagnostics, so the Thread diagnostic surface cannot recover it. The observation instrumentation was removed. This is a reproduced observability gap; it still does not identify the historical live catalog failure cause.

The UI accepted-veto review’s cancellation@10 followed by acceptance@11 was tested only as direct registry input. Two real-engine controls establish that the current same-attempt path positively cancels before provider dispatch and returns; the accepted-send race interrupts the accepted provider turn rather than emitting restoration cancellation. The proposed blocker was withdrawn and no disposition/rollback fix was approved from that unreachable ordering.

### Obsolete queued reviewer instruction delivered after handoff

UI Thread agent-af72e91d3fdba6ee4bcaf143e1ae62fc completed its frozen handoff at11:56:09 UTC (107 browser tests,197 focused product tests, web typecheck reported passing). The older reviewer instruction `agent:6c0b8a58-4c1c-4d45-9e37-1aae86c678ce:message`, created11:37:34, was then delivered at presentation sequence2667076 after that handoff. It requested the already-withdrawn cancellation@10/acceptance@11 fix. Parent interrupted its exact obsolete turn and resent the sole current post-capture/admission recovery review as immediate steering. This is an observed stale-instruction delivery hazard, not evidence that the withdrawn product fix is needed.

### Continued handoff review (12:08–12:15 UTC)

Parent verified all six L10 manifest base/final hashes and patch SHA against actual files. Independent reviewer exercised short secret, known typed cycle/depth, and oversized operation/method controls: secret redaction/cycle termination passed; operation/method were unbounded at 5,010/5,007 characters. Current call sites use internal literals, so this is a new-helper contract gap, not evidence of the historical provider cause. Owner is tightening the bounded contract and strengthening tests before integration.

UI owner reported implementation before executing requested RED controls; parent explicitly required the exact frozen 107-browser/197-unit source baseline, not reconstructed pre-fix paths, and retained the process deviation. Additional source review identified local-draft rollback after uncertain start RPC as a candidate for the same executed control; no defect is claimed until that control runs. Attachment cancellation already rejects claimed assets; no speculative attachment rewrite was approved.

Parent read command using an unmatched shell glob failed before reading files; corrected to rg with explicit paths. This was a tooling error, not a product failure.

### Gateway provenance integration (12:19 UTC)

Six files integrated after parent verified manifest base/final hashes, patch hash, apply-check, backups, and resulting hashes. Canonical task record: `.penkra/scratch/lifecycle-20260907/gateway-provenance-integration-result.json`; owned file list `gateway-provenance-integrated-files.json`. The refreshed isolated suite passed 18 tests. Operation/method content is bounded to 256 characters plus truncation marker; provider is restricted to known ProviderKind values (the worker final wording incorrectly attributed the provider allow-list to operation/method). Combined workspace checks remain pending. Historical live catalog cause is still unknown.

UI promoted-local-draft control reproduced one thread.delete after thread.create succeeded and thread.turn.start returned unknown acceptance; the minimal guard now prevents rollback once start was dispatched. Another bounded remount control failed an exact-message-ID assertion; parent required concrete owner/call-trace diagnosis rather than accepting a green retry as proof of unrelatedness. UI delta remains isolated.

### UI final gate and frozen-artifact discrepancy (12:33 UTC)

The current UI source passed the full ChatView file: 110/110, 79.23 seconds; focused product gate 197/197 across nine files and web typecheck exit 0. The four bounded follow-up controls passed after an existing exact-release mechanism was used for browser-test isolation only, between tests (not during remount/reload controls). The preceding unknown-outcome fixture had retained a module registry owner across store reset; attempted accepted-event teardown did not settle it and that failed result remains evidence.

The saved patch SHA-256 `762b65e1d6a130246e83f635f804df1c7a3e346967c580854e47bf667b7000bf` reconstructed ChatView Git blob `a658c1c82b0b1303554fde292866050191d370da`, registry `e360b2ea00fee0c619d273769fbcd2b17c6bd6b9`, and browser test `60562b81c7eb7ceeaa36f09f2db297c428e19d17`. These do NOT match the old manifest finalBlob claims. That manifest is invalidated; it is not accepted as proof of exact 107-test baseline bytes. Owner is executing the new controls against the genuine reconstructed runtime artifact in separate browser processes, preserving and restoring current fixed bytes. This does not erase the earlier reproduce-before-fix process deviation. Main UI integration remains withheld until reconciliation.

Parent combined inventory audit found 74 owned files before durable UI integration; the only changed/untracked files outside the integration manifests were exactly the nine initial unrelated browser files. No broad formatting or final checks have run yet.

### Correction to baseline audit (12:36 UTC)

Parent independently calculated both raw SHA-1 and Git blob SHA-1 on the reconstructed artifact. Raw SHA-1 values are exactly the old manifest finalBlob strings: ChatView `799b224e4a5ddb10c150746568ed1c0f7d875351`, registry `5fe9fb21fff560e462bceb708c6b8432b63820c9`, browser `99caab7bb3d5f8e91ff159113b3e39e179710af2`. Thus the previous conclusion that artifact bytes differ is withdrawn: the manifest mislabeled raw SHA-1 as Git blobs. The saved bytes are verified by the intended raw digest. Parent owns that mistaken interpretation and records the correction.

The independent runtime comparison also overlapped the UI owner temporarily restoring reconstructed runtime files for RED replay. Its claim that only browser changes were omitted applies to that transient test state, not the final fixed source, and is withdrawn for final-integration purposes. Final source comparisons must use frozen artifacts. UI owner reports four actual reconstructed-source REDs: unresolved checkpoint after pre-start staging failure, incorrect queued restoration on unknown RPC, zero admitted-owner remount lookups, and one promoted-thread delete after uncertain send. Restoring exactly tested fixed bytes is pending; no repeated broad tests are needed if those bytes match.

### Final UI catch review hold (12:39 UTC)

Parent verified all 12 current-main base and lane final Git blob hashes against the new finalFiles manifest. Source diff against the actual preserved baseline exposed a remaining candidate crash window: known pre-dispatch failure calls durable failed settlement/clear before later generic composer restoration. markPendingStartRecoveryFailed changes disposition but does not restore content. Owner is executing an actual ChatView journal-checkpoint control before any additional source change; no lost-input defect is claimed until that runs. If confirmed, the approved path is existing atomic restoration plus receipt before acknowledgement/clear, without a second recovery ledger. The 110/197/TSC-tested bytes remain the reproduction baseline, not yet integrated.

A parent read used a mistyped working-directory path and failed before process creation; corrected exact path read succeeded. No files changed from the failed command.

### Durable pre-dispatch restoration controls (12:43–12:54 UTC)

P-10 reproduced actual prompt loss by rehydrating an acknowledged clear snapshot from the 110-tested runtime: prompt was undefined. The correction uses existing atomic restore plus receipt, then acknowledgement/clear, rather than marking failed and clearing before generic restoration. P-11 then reproduced an optimistic history row remaining beside restored input because a new payload-restore fence also skipped row cleanup. Cleanup and duplicate-payload prevention are now separate.

P-12 initially failed image rehydration; the timing/fixture explanation was not accepted. Independent reviewer058 traced capture awaiting readFileAsDataUrl before flushing recovery. Before correction, restore copied images but omitted persistedAttachments, so the actual acknowledged clear snapshot had attachments:[] and hydration correctly yielded no images. No IndexedDB lookup occurs for this inline-data fixture. The minimal correction reuses persistQueuedComposerImages when restoring into an empty composer, before clearing recovery; paused-row serialization already uses that serializer. Exact checkpoint now includes image id/dataUrl, and awaited rehydrate returns the image.

The staging control passed including checkpoint prompt/image and absent optimistic row; all four bounded controls passed (106 skipped) on corrected source. Final full ChatView/197-unit/web-typecheck gates are underway before hash freeze/integration. No production or native-flow acceptance is inferred. The obsolete checkpoint-shape assertion failure is retained separately from product REDs.

### Durable UI integration (12:59 UTC)

Integrated all 12 frozen UI files. Parent verified current-main base digests, frozen final raw SHA-256/Git blob digests, patch SHA-256 `4f61f587dec025a4a7b4e89fbc258d3cd91f052048b6317ee3301680e560f1c9`, apply-check, backups, and resulting digests. The actual source bytes match the 12:55:15 freeze with final110 browser/197 focused unit/web typecheck exit0. The canonical integration record is `.penkra/scratch/lifecycle-20260907/durable-recovery-integration-result.json`; explicit file list is `durable-recovery-integrated-files.json`. All retained RED evidence stays outside the product patch. Combined workspace checks follow; native acceptance remains blocked/unverified.

### Final combined verification and native boundary (13:07 UTC)

The final runner covered 80 owned files. Initial owned formatting, whole format check and lint passed; typecheck failed with one Effect.map inference error in the gateway diagnosticWrite union value channel. Explicit `Effect.Effect<"retained" | "write-failed" | null>` fixed the type without changing runtime error handling. Targeted formatting passed, gateway regression passed18/18 across3files, and only the failed whole-workspace typecheck was rerun: exit0, 11/11 tasks, 47.232seconds. Initial failure and successful rerun remain in `.penkra/scratch/lifecycle-20260907/verification/final-integrated-results.json`. The original fmt/fmtCheck/lint gates were not repeated. Final UI source had passed110 browser and197 focused unit tests before integration.

Two harness/diagnostic errors remain explicit: the claimed missing root manifest was false (the regular64-entry file existed, no runner path changed); a wrapper used zsh read-only variable status and failed after the runner, without changing the recorded gate results. The main coordinator final raw SHA-256 is `77637be9fac60d56ff0513c42546c562f1fd814564978ceee4b8403fb174c9ee`; its post-format Git blob is `3e4b9ce94f04e45429488c6b478400f3191ffc31`.

A fresh read of System Events UI-elements-enabled returned false. No final native affected-flow QA was possible; earlier Dev30 startup is not evidence of native acceptance after integration. The task is not fully validated, and no commit/release/version change was performed. Native access and the pending quota/image product choices are the remaining operator boundaries. Task artifacts are retained for those acceptance steps with an explicit root retention README.

## OpenCode image-count upstream audit correction

The earlier recovery-choice question preceded completion of upstream issue/release research. It was premature: the user rejects a new image picker, and existing explicit Edit-and-resend remains available without an added confirmation flow. Historical HerWebCraft progress does not support automatic never-dispatched restoration.

The pinned [v1.18.29 message assembly](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/session/message-v2.ts) retains un-compacted tool attachments and extracts media into synthetic user messages where required by the model API. The pinned [pruner](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/session/compaction.ts) protects recent user turns and estimates textual tool output; enabling pruning does not establish prevention of the reproduced same-turn image accumulation.

An isolated execution of the exact extracted [pure overflow classifier](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/llm/src/provider-error.ts) returned false for both the historical four-image error and fixture wording. Positive prompt-length/entity-size controls returned true; a rate-limit control returned false. The [API error parser](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/provider/error.ts) separately recognizes HTTP 413 and structured context_length_exceeded. The [session processor](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/session/processor.ts) enters error-triggered compaction for a typed ContextOverflowError and otherwise settles the error. This establishes a classifier limitation, not the unavailable historical error envelope or a validated recovery fix.

Pinned source digests, classifier output and investigation command errors are retained in `.penkra/scratch/lifecycle-20260907/upstream-image-research/`. No product code changed and no provider experiment was rerun for this audit.

The official upstream review found [issue 47487](https://github.com/anomalyco/opencode/issues/47487) and [PR 47493](https://github.com/anomalyco/opencode/pull/47493), which address accumulated tool images at a 50-image provider limit. The GitHub API returned PR 47493 closed, merged=false, merged_at=null, head dfd585ff2e5b1dbfabe145564da44b8ce7135e18. [PR 40167](https://github.com/anomalyco/opencode/pull/40167), an Azure count/payload classifier proposal, returned open, merged=false, merged_at=null, head f2a35b4c1781e9bc9a2c640c10e96ddd3505a51a. These are upstream proposals, not confirmed released fixes for this incident.

Independent execution of both PR heads' extracted pure classifiers returned false for HerWebCraft's exact visible four-image error. Each returned true for its respective target wording (51/50 images for 47493; maximum number of images for 40167). PR 47493's fixed cap of 40 also cannot prevent a provider limit of four. Thus neither proposal can be presented as a drop-in solution for this case. Status records and characterizations are retained with the pinned-source audit. The worker's phrase “Luna High v1.18.29” conflated the research worker model with the OpenCode runtime version; no evidence identifies HerWebCraft's failed model as Luna from this review.

## Resumed native Dev30 acceptance

After user-approved deferral of the upstream image-count limitation, canonical Applications Dev30 was freshly launched. A bundle-ID launch first opened bare Electron; that task-owned app was quit and confirmed absent. Canonical path launch returned Computer Use timeout -10005, but the subsequent app observation showed running DevTools on localhost:5733; closing DevTools exposed the real local test workspace. These are launch/automation observations, not lifecycle acceptance. Luna and High were selected through the native menus.

Thread 2d121e7a-7178-41de-ac99-c2a950b1cc24: initial camping request displayed Thinking and Stop after send. Stop occurred after processing had begun, retained partial response/history and left the composer empty. This is not a pre-admission quick-Stop proof. During a second long response, Return queued “Make the meal plan vegetarian.” Delete removed its text and queued control by the next observation (1,388ms including automation capture overhead); no precise render-latency claim follows.

The next paste+Return follow-up, “Make all meals vegetarian and avoid peanuts.”, crossed the previous response completion boundary. It appeared in history and produced a new streamed response while the exact prompt remained in the composer across three native observations. Accessibility and screenshot evidence are retained in `.penkra/scratch/lifecycle-20260907/native-repl-20260907/resume-boundary-followup-confirmed.txt` and `.png`, with earlier send/Stop/queue/delete states. This is an observed native defect; causal attribution and repeatable browser control were assigned to the UI owner before any runtime fix.

Native follow-up narrowed the duplicate-composer observation: a settled-idle paste, observed state, then Return cleared normally (`idle-return-control.txt`). A settled-idle paste and immediate Return without that intermediate observation reproduced retained submitted text (`idle-immediate-paste-return-failure.txt`). Therefore crossing response completion is not necessary; input persistence/editor ownership timing remains under investigation. The first failing text persisted after the response fully settled (`resume-boundary-followup-settled.txt`). A later paste during completion was absent at next observation, but there was no intermediate evidence it landed in the editor; this remains a weaker focus/remount observation, not established draft loss (`completion-new-draft-missing.txt`).

Independent Dev30 launcher correlation found six accepted turn-start admissions and one accepted queued cancellation in the 11:30–11:33 local-prefix window. The file ends at 11:33:52.004 and contains no later records for the requested 11:34–11:38 window. It lacks message text/provider-delivery receipts needed to infer duplicate delivery. The queue start and cancellation therefore prove command admission only. The worker's initial failure to locate `delayed-input-appearance.txt` was a search diagnostic error: parent `ls` and node filesystem listing both confirmed the exact absolute task-root path, 55,244 bytes, modified 11:37. A direct-path correction was requested. Later clipboard/frame/window errors and stale-route observations prevent interpreting automation capture intervals as product latency.

The UI lane subsequently executed a controlled ChatView browser RED on the current-main snapshot with no runtime fix: real editor input preceded its 50ms store-persistence timer, Return dispatched the exact new prompt, and the composer-clear assertion failed because the submitted prompt remained. The retained lane log records one failure, 110 skipped, 30.50s. Parent inspected the test and failure record in `native-followup-luna-20260907/harness-and-error-log-2026-09-07.md`. This establishes a product composer-clearing defect independently of later native automation staleness; it does not establish duplicate provider delivery. The initial browser run failed dependency resolution before assertions; the lane installed its own frozen lockfile dependencies instead of changing main's package versions.

The log-review worker read the exact delayed-input artifact and withdrew its not-found claim. The artifact shows the existing thread route and guide text in the composer, with Send available, but records no send action.

Dependency diagnostic correction: parent independently ran `import.meta.resolve` from main `apps/web`; both @dnd-kit/react and @dnd-kit/dom resolved successfully into main's Bun package store. Thus the lane's initial resolution failure does not establish an incomplete main installation. The temporary root-node_modules symlink did not reproduce the web workspace's dependency topology. The earlier “main missing declared dependencies” description is withdrawn; the lane-local frozen-lockfile install remains appropriate.

The follow-up reviewer initially resolved Git at the enclosing main repository instead of the source snapshot lane and withdrew the resulting broad diff. A later “implementation matches current main” statement was contradicted by parent direct SHA-256 checks: main ChatView remained `63e88bec181d2ef34ddb57aa6916688f7be89df22b2d4571986dc93e626c18d5`, while the first isolated implementation was `4d7da94fb4fc58946d683b7bc582f2d61589107ea3942bd26ef3240ff7628fac`. These are source-provenance diagnostic errors, not product failures. Parent required explicit absolute-path review; no integration was inferred from those statements.

Follow-up process deviation: the UI owner confirmed an accidental main ChatView runtime hunk was applied then immediately inverted before lane testing. Parent observed the restored baseline hash with file mtime 11:55:02 MDT (17:55:02Z); the owner's later “11:55:02Z” wording was a timezone error. The “main was not edited” claim is withdrawn. Earlier native captures predate this temporary write; no claim is made about HMR observing it. Parent subsequently integrated the frozen reviewed files at 18:12:08Z with exact baseline/final hash checks and backups.

Parent verification on integrated/formatted main: scoped web typecheck passed. The six-control browser run returned five passed and one failed at the immediate-Return test's pre-dispatch setup assertion: the real 50ms timer had already projected the prompt before Return, so the intended pending-input precondition was absent. This is a nondeterministic test setup failure, not evidence the final clear predicate failed. Original runtime RED evidence remains distinct. The owner was assigned a deterministic timing control, including unchanged-baseline RED versus fixed GREEN, without runtime edits or retry-until-pass.

Final deterministic timer control: original baseline reached dispatch and failed composer clearing (1 failed, 114 skipped, 26.05s); fixed runtime passed. Parent reviewed and integrated the test-only 48-line delta. Integrated focused browser run passed 6 tests, 109 skipped, 22.82s; scoped web typecheck exited 0. Logs: `.penkra/scratch/lifecycle-20260907/verification/native-followup-main-browser-timer.log` and `native-followup-main-typecheck-timer.log`. Targeted formatting passed. Browserslist stale-data warning was retained without unrelated dependency changes. A parent evidence-write command used an incorrect working-directory UUID and failed before execution; the corrected command wrote this record. Native acceptance remains pending reliable capture after ScreenCaptureKit -3811; no commit or release.

Fresh post-integration Dev30 acceptance resumed at 12:31 MDT. Canonical launch returned Computer Use timeout `-10005`, but the app subsequently appeared as running. DevTools again had focus and was closed through its freshly resolved accessibility close control. Native capture then succeeded. On new Thread `91f005f2-38e0-4b02-beee-447162c89ea8`, “Give me a three-item checklist for preparing a day hike.” appeared once, received a completed response, and left the composer empty. An immediate typed follow-up, “Add one sentence about checking daylight and turnaround time.”, likewise appeared once and later completed with an empty composer. Exact relevant AX excerpts are retained in `.penkra/scratch/lifecycle-20260907/verification/native-followup-final-direct-send-state.txt`; the full returned states remain in the parent Thread's provider-native tool records. This is native acceptance of the direct text send/clear path after integration; it does not establish attachment, navigation, or queued-command acceptance.

The same run retained several automation failures. A native paste attempt timed out waiting for the application to read the clipboard. A fresh composer accessibility target returned `elementHasNoFrame`; coordinate click then returned `noWindowsAvailable`. Later `set_value` and `type_text` calls sometimes completed without visible insertion until a subsequent action, and other attempts produced no insertion. One long prompt was confirmed in the composer and successfully dispatched only through the visible Send button. A response rendered with Working, partial structured output, Thinking, and Stop-generation states before settling. The attempted queued follow-up could not be admitted before settlement because the automation input did not land. These failures are harness evidence and prevent treating queue/delete/steer or exact input latency as native acceptance. No duplicate provider delivery was observed or inferred.

Final workspace gates exposed and retained two new failures: format check identified `apps/desktop/src/main.ts` and this evidence file, and typecheck rejected passing nullable Electron `WebContents` to the trusted media-requester resolver at `main.ts:7865`. Lint passed. Targeted formatting corrected the two files. The permission-check callback now maps a null sender to a null trusted requester before applying the existing trust predicate; no permission is granted by the null case. The failed gates alone were rerun: format check passed all 2,626 files, and typecheck passed 11/11 tasks in 21.417 seconds. `git diff --check` is clean. Final source hashes are recorded in the retained verification result.

Formatting `main.ts` caused the development watcher to restart Dev30. The old shell stayed visibly blank after launcher logs showed clean server startup and orchestration synchronization, so it was closed. A second canonical fresh launch succeeded after the usual launcher timeout, DevTools was closed, and the Penkra renderer opened on new Thread `a1ffa4e5-bb8a-49d0-9bf0-7371175af84f`. This establishes a healthy fresh post-gate startup. The automation placed a 40-item prompt in that composer. AX Send and Return actions initially appeared to do nothing, while the coordinate path reported `windowNotFoundAtPosition`; a later fresh observation showed that the prompt had in fact been dispatched, completed with 40 items, and cleared from the composer. A subsequent 100-item input action never appeared. This strengthens the direct-send/clear acceptance while confirming that automation-observation timing cannot support click-latency or queue-admission conclusions.

Quota/credit recovery product decision: add no Resume button, recovery panel, or other new UI. Returning capacity must not silently restart a stopped turn. The user can send “continue” or any ordinary follow-up through the existing composer. This is a new turn initiated through the normal message path, not automatic replay of the failed or stopped turn.

Native launcher diagnostic correction: after a provider-turn boundary reset the node_repl state, `get_app_state` was called with the Dev30 bundle identifier while the canonical app was no longer running. Computer Use auto-launched the raw Electron runtime and displayed Electron's default app. The initial parent commentary called this a Dev30 launcher fallback; that attribution is withdrawn. The raw Electron window was closed, and the canonical `/Applications/Penkra Dev 30.app` launcher was used again. This is automation-target behavior, not evidence that Penkra's launcher fell back to the Electron default app.

### Immediate queued-action acknowledgement and final native acceptance

The screenshot-specific browser control separated the initial queue-admission wait from the queued
action acknowledgement wait. Current source failed all three pre-fix cases: Steer, Delete, and Edit
each left the queue row visible after the action claim while the receipt was held. The first
post-fix control exposed stale test expectations and a missing synthetic `server:<messageId>`
identity fence; those were corrected without hiding the failures. The isolated lane then passed
four screenshot/rejection controls, 18 focused browser controls, and seven ownership tests.

The integrated fix makes the existing synchronous queued-action owner control visible placement.
A claimed local turn and its matching server reconstruction disappear immediately. Releasing a
rejected claim restores the authoritative queued row; an accepted receipt keeps it suppressed until
the server projection settles. The parent consolidated overlapping worker controls into the
existing delayed-admission matrix and retained one distinct server-rejection control. The resulting
main run passed seven selected ChatView browser controls (110 skipped). A first formatting command
used repository-relative paths from `apps/web` and exited 66 before touching files or starting
tests; formatting from the repository root succeeded.

Canonical Dev30 was relaunched after an initial bundle-ID probe again opened raw Electron. Computer
Use captured the real app but exposed only the Electron shell container; coordinate clicks returned
`noWindowsAvailable`. The running Dev30 renderer's local Chromium endpoint was therefore used for
the same native desktop window. The first Playwright sequence timed out waiting for a Send button
after the first message had already started: during an active turn the button is correctly Stop,
and the second probe remained unsent in the composer. The sequence resumed from that verified state
using Enter rather than replaying the first send.

Fresh native Thread `afd9e31e-246e-4666-8f01-266fe271c677` produced these observed results:

- Delete: the queued row disappeared within 516ms of Playwright click initiation; the probe was
  absent from the transcript and body, and the composer was empty.
- Edit: the row disappeared within 315ms; the exact queued prompt returned to the composer and had
  zero transcript copies.
- Steer: the row disappeared within 412ms; the composer cleared and exactly one transcript message
  appeared.

The active long-running turns were stopped after the controls. These intervals include Playwright
action overhead and renderer observation, so they are upper bounds for visible acknowledgement,
not raw React paint latency. No external App operation was invoked. This is native acceptance of
queued Delete/Edit/Steer placement and single-owner behavior after integration.

An independent clean-baseline server lane also re-established the canonical sequence RED:
`thread_activities_read.sequence` was NULL while the accepted receipt was 8. Applying the current
main Migration 161/ingestion/diagnostic delta passed 102 focused tests and 18 migration replay
checks. The recorded sequence-loss and diagnostic-omission defect is therefore fixed in current
main; no additional runtime change followed from that audit.

Fresh native New Deck Thread `de9ca1e8-a3a8-4ad6-85fa-cf9781d0ba5c` then passed a complete
first-to-second sequence. Each send showed Thinking and Stop, each user prompt appeared exactly
once, both responses completed on the same Thread, and the composer was empty after each
settlement. The provider returned the requested `FIRST ACK` and `SECOND ACK`. This closes the
observable New Deck case without introducing a Resume control; ordinary composer submission is
the recovery and continuation path.

The same native Thread accepted `favicon-32x32.png` through the real photo input. Before send the
composer had one preview. After completion the composer-scoped preview count was zero, the
transcript user row appeared once with one image, and the composer text was empty. A first
unscoped count returned one because composer and transcript reuse the same accessible preview
label; the scoped follow-up established composer zero/transcript one. The provider described the
received icon. No generated or external asset was used.

An unsent navigation control placed `NATIVE NAVIGATION DRAFT PROBE 20260907` in that Thread,
navigated to Thread `afd9e31e-246e-4666-8f01-266fe271c677`, then returned. The exact draft was
restored and was subsequently cleared. This is native acceptance of per-Thread draft ownership
through navigation.

### Reconnect and New Deck controlled closure

The reconnect control now supplies the active Thread page during the sync handshake after forcing
the fixture WebSocket closed. It verifies one retained user message, one streaming assistant
message, the first assistant delta exactly once, Thinking, and Stop after a new socket connection.
The original zero-delta attempt was a fixture error because its reconnect snapshot contained only
the shell. No reconnect runtime change was justified by that invalid control.

The New Deck control holds `thread.create` and each `thread.turn.start` acknowledgement separately.
It verifies one draft promotion, one first start with immediate Thinking/Stop, settlement, and one
second start on the same Thread with the composer cleared. An intermediate control referenced an
undefined saved native API, then a corrected version attempted its second send before the control
had established draft ownership and an enabled Send button. Both harness errors were retained and
corrected rather than treated as product failures. TanStack's `_nonReactive` console diagnostic
also occurs in an existing passing New Deck fixture and remains a known test-harness warning.

The isolated combined run passed both controls with 116 skipped tests. Its frozen patch SHA-256 is
`6531960232bd7c4c1d6cf1ecb9db8975d71705364ccf001a3fd2cd2e1da02752`; the source matched the
lane SHA-256 `e7a81a7427d9fd333e197776fd64b4c0950f2ceacd99884fb6fe3b3c7ddd8236` immediately after
integration. The parent combined selection then passed nine controls with 109 skipped. The stale
Browserslist data warning remains visible and was not addressed through an unrelated dependency
update.

After integration, the complete ChatView browser suite passed 118/118 in 98.11 seconds. This run
included the existing lifecycle, composer, recovery, ordering, and queue controls alongside the
new reconnect and New Deck cases.

The parent retained its packaging and command errors. A checksum probe mistakenly queried a
nonexistent `.sha-does-not-exist` sidecar while the valid checksum record succeeded in the same
read-only batch. The frozen patch's absolute/new-path headers did not survive default `git apply`
stripping. Two repository patch-tool attempts then failed before mutation: the first used a path
relative to the repository instead of the client workspace, and the second retained numbered
unified-diff headers unsupported by that tool. The reviewed hunks were applied after correcting
both representations. Finally, the browser package script was first invoked from the repository
root where it is not defined; no test started there, and the test was rerun from `apps/web`.

### Repository gates before the investigation was incorrectly closed

After the final test and evidence integration, `oxfmt --check` passed all 2,626 matched files.
Repository typecheck passed 11/11 tasks in 11.814 seconds. Repository lint completed with zero
errors and 515 warnings; the quiet project script reports the count without individual warning
locations. Replayed build output also retained declaration-generation plugin-timing warnings and
the existing Astro/Vite `optimizeDeps.esbuildOptions` deprecation warning. These warnings were not
silently characterized as fixed or changed through unrelated dependency work.

### Reopened basic-send regression from native recording

The prior conclusion that the lifecycle scope was complete was wrong. The attached 4.563-second,
218-frame Dev recording shows a first `Hi` send from New Folder. The user bubble and Thinking row
appear, disappear together for a short promotion interval, and then return. The sidebar creates the
new `Hi` row but continues to show its provider icon while the transcript says Thinking.

FFmpeg signal analysis of the relevant screen regions confirmed a blank interval rather than a
single compression artifact. The first Python pixel-analysis attempt failed because Pillow is not
installed; FFmpeg's built-in `signalstats` filter was used without installing a dependency. The
source recording, 10fps contact sheets, all 218 decoded frames, and region statistics are retained
under `.penkra/scratch/lifecycle-20260907/video-hi-144339/`.

The recording came from development instance 1, not instance 30. The instance-1 launcher log and
the renderer's retained development lifecycle buffer identify Thread
`d3668bbf-92db-45df-90be-81aaf71927f4`. The command log records `thread.create` accepted at
14:43:41.695, an empty Thread page loaded at 14:43:42.072, and `thread.turn.start` accepted only at
14:43:44.592 after provider admission. The renderer trace records one optimistic message and
Thinking before promotion. At 20:43:41.969Z, the Thread changes from local-draft to server-backed
with `threadDetailHydration=loading`, while the optimistic count remains one and `showThinking`
remains true. The transcript is nevertheless replaced by the hydration surface. At
20:43:42.035Z, the timeline mounts again and records Thinking visible a second time. This is a
presentation continuity defect across promotion; the message was not lost from local state.

The same evidence explains the sidebar mismatch boundary. Transcript working state begins from the
local send owner, while the sidebar derives its icon only from the server Thread status pill. During
the provider-admission interval, the new shell row exists but has no running lifecycle state, so it
shows the provider icon while the transcript shows Thinking. Existing diagnostics record transcript
derived state and Thinking/timer row transitions, but omit exact visible message IDs, transcript
surface replacement, sidebar work-status inputs, and DOM commit continuity. That instrumentation
was insufficient for the reported failure.

The instance-1 log later records repeated `EEXIST` temporary-file opens and matching `ENOENT`
renames for composer snapshot writes. Those are separate real errors after the recording and remain
under controlled reproduction; no causal relationship to the promotion flicker is inferred.

A Penkra Thread lookup performed from the parent conversation's current Space returned an unrelated
older Thread titled `Brief Hello Greeting`. It is not the Dev instance-1 Thread and none of its
events are used in this diagnosis. An initial parallel evidence script also contained a JavaScript
syntax error and executed nothing. Both diagnostic mistakes are retained here.

The corrected browser control now forces the missing native boundary explicitly: a promoted server
shell is present while its detail-sync marker is absent and its detail-page receipt is held. It
samples the DOM every 8ms for 160ms. The exact optimistic message and Thinking remain visible and
the hydration placeholder does not mount. The selected control passed with 117 tests skipped. Its
runner still reports TanStack Router's `_nonReactive` preload exception; changing the test shortcut
helper from repeated dispatch to one dispatch did not remove it, so that hypothesis was rejected and
the helper restored. This exception remains a separate harness/router defect rather than clean test
output.

The transcript correction keeps a provisional transcript surface mounted whenever local optimistic
messages or locally owned work exist. While detail hydration is incomplete it passes only optimistic
messages to that surface, so retained server rows remain hidden until the authoritative page arrives.
Development diagnostics now record the selected transcript/hydration surface, visible timeline IDs,
local-dispatch identity and acknowledgement state.

The first native post-fix replay on instance 1 used Thread
`e14174d1-4738-4e00-a6ce-926b8fe28361`. It established continuous user-message and Thinking
visibility but exposed a remaining sidebar interval: `running` became `idle` for about 1.32 seconds,
then returned to `running`. Sidebar samples showed that the draft-promotion marker ended before the
server running projection. A second attempt added the admitted pending-message projection and still
captured two shorter idle gaps, proving that adjacent independent flags do not guarantee frame
continuity.

The final predicate retains the exact shared composer send owner after command acceptance and releases
only the matching dispatched message when the active Thread observes authoritative server
acknowledgement. Error and blocker status continue to take priority. `SidebarThreadSummary` also
retains `pendingTurnStartMessageId`, and development sidebar diagnostics now record promotion, local
owner, pending message, session, turn, status-pill, and final work-icon state together.

Fresh instance-1 Thread `97c6c0d1-3fa2-4c54-8093-323f519a3fbd` is the current native acceptance
record. An 8ms MutationObserver/interval probe saw the exact `Hi` user row appear at 326.5ms, the
sidebar enter `running` at 660.1ms, and both remain continuous until settlement at 8.553s. Results:
`userGap=false`, `thinkingGap=false`, `sidebarGap=false`, and no loading placeholder. The retained
artifact is `.penkra/scratch/lifecycle-20260907/native-instance1-hi-owner-until-ack/result.json`.
The matching launcher interval contains no warning or error; it does report Computer Use preflight
as degraded because raw MCP is missing while node-repl is ready.

The composer snapshot collision was independently reproduced by freezing `Date.now`, holding the
first atomic write, and invoking a second write. Before the correction, one write failed `EEXIST`,
the other failed `ENOENT`, and the newer snapshot was not committed. `writeSnapshot` and
`removeSnapshot` now share one per-journal mutation queue, preserving invocation order. Its focused
suite passes 5/5. The worker unintentionally applied these two files directly to main rather than its
isolated lane; parent detected that provenance error by exact Git blob hashes before review and kept
the reviewed change.

During focused verification, the repository Turbo wrapper was incorrectly passed file paths and
rejected them as missing task names. Package-scoped Vitest commands replaced that invalid invocation.
Two later browser-fixture attempts failed because the synthetic known-empty marker was still present;
a third failed from a `detailSyncById`/`threadDetailSyncById` variable-name error. All were corrected
before the passing held-hydration control. Typecheck then found and prompted corrections for a
hydration fallback narrowing error and an unbranded test MessageId.

The first attempt to accept the composer journal correction in the native app was rejected as
evidence. Electron PID 9881 and `dist-electron/entry.js` still dated from 13:21, before the journal
source changed, and the emitted desktop bundle did not contain the mutation queue. A one-shot
`tsdown` build completed successfully and the instance-1 watcher restarted Electron as PID 48043 at
16:16:22. The new `dist-electron/main.js` contains the serialized `#snapshotMutation` chain.

The first post-restart automation probe then timed out looking for a `textarea`. New-Thread composer
input is a `role=textbox` contenteditable, and an HMR reconnect occurred during that invalid run.
After correcting the selector, reloading the draft route, and waiting for a stable renderer, fresh
Thread `7ab80df1-1112-4218-bab2-35d10da410d5` completed a real `Hi` turn. A 4ms interval plus
MutationObserver saw the user row at 555.6ms, the sidebar enter `running` at 872.3ms, title change
while running at 7.391s, and settlement at 10.599s. Results were `userGap=false`,
`thinkingGap=false`, `sidebarGap=false`, `loadingSeen=false`, with all three required states observed.
The exact accepted artifact is
`.penkra/scratch/lifecycle-20260907/native-instance1-hi-post-restart/result.json` (SHA-256
`3c3dbc3375d1654779743e81832966bedbd1a659749cfb95ccfd33b833ef238b`).

The matching launcher interval contains 209 lines and no `WARN`, `ERROR`, `EEXIST`, `ENOENT`,
exception, or unhandled record. It retains an informational Computer Use preflight marked degraded
because node-repl was ready while raw MCP was missing; this did not affect the renderer-driven test.
The interval artifact is
`.penkra/scratch/lifecycle-20260907/native-instance1-hi-post-restart/launcher-interval.log`
(SHA-256 `720d56485783713e0d15128de472e4b1ea7d1a47387e597bfcb879912a3b7559`).

The final full ChatView browser run initially remained at 117/118: the cross-folder drag control
timed out asking Playwright to click a destination folder after the authoritative reparenting
snapshot. A diagnostic attempt first referenced nonexistent `AppState.threads`; correcting it to
the normalized `threadShellById` established that the folder was present and the product store was
consistent. The failure was a harness actionability race: Playwright could re-enter the stale drag
target while React committed the snapshot. The control now waits for the drag overlay to disappear
and invokes the current HTML folder button directly. Its two-drag subset passed 2/2 and the complete
ChatView browser file passed 118/118 in 90.04s.

Final format check passed all 2,628 matched files, and repository lint returned zero errors with 515
warnings. The first final typecheck correctly rejected the direct DOM click because the locator type
was `HTMLElement | SVGElement`. The control now asserts and narrows the target to `HTMLElement`.
Repository typecheck then passed 11/11 tasks, and the corrected focused cross-folder control passed
with 117 tests skipped. A parent command first used the nonexistent package script `test:chat-view`;
it failed before starting a test, and the valid `test:browser:chat-view` script produced the recorded
pass.
