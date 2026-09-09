# Thread lifecycle corrective evidence, September 9, 2026

This document records the reproduced regressions and verification for the corrective desktop
candidate built from released Penkra 0.12.3. Active work remains in the ignored repository-root
`TODO.md` until publication and installed-update acceptance are complete.

## Cross-thread steering presentation

The reported failure showed a steering message sent from one Thread appearing in Strategy after
navigation. Released 0.12.3 inserted the local steering presentation only after awaiting the
`thread.turn.steer-queued` command receipt. The mounted `ChatView` could change Threads during that
wait, allowing its post-receipt component-local update to render under the newly selected Thread.
The same wait also delayed the `Steering conversation` marker.

A controlled Chromium fixture held the steer receipt, navigated from the origin Thread to another
Thread, and then released the receipt. Before correction, the message could be inserted through the
component that now represented the other Thread. The corrected ownership registry captures the
exact queued turn synchronously and indexes both in-flight and accepted presentation by its origin
Thread. Rejection returns the exact row to an actionable queued state; accepted ownership remains
until a matching-or-newer settlement sequence is observed.

The focused controls cover immediate message-and-marker presentation, navigation while admission
is delayed, remount before settlement, accepted non-actionable presentation, rejection rollback,
and retry. The complete ChatView Chromium run passed 120 of 120 tests.

## Sidebar lifecycle convergence

Two independent stale-sidebar mechanisms were reproduced.

First, composer preflight ownership was shared across the shell but acknowledged only by a mounted
`ChatView`. If the origin view unmounted after admission, the sidebar could retain local send
activity after the durable `thread.message-sent` event. The root synchronization router now
acknowledges the exact `(threadId, messageId)` globally.

Second, released 0.12.3 treated a persisted draft `promotedTo` value as sufficient evidence of
active work even after an idle canonical sidebar summary existed. A test added to an isolated
0.12.3 checkout failed by returning `Working` instead of `null`. The corrected resolver uses
promotion alone only before a canonical summary exists; an active local owner, pending start, or
active canonical lifecycle still displays work.

Native Penkra Dev diagnostics reproduced the stale state with a canonical idle summary, no local
send owner, no active session or turn, and only the old `promotedTo` value. After correction and a
fresh restart, the spinner was absent.

## Live read acknowledgement

The `thread.updated` reducer applied title and note metadata but omitted `lastVisitedAt`, so a live
read acknowledgement could be discarded until a later full synchronization. The isolated 0.12.3
control failed both the active-thread and sidebar-summary assertions, retaining the older timestamp.
The reducer now applies the field to both projections. This is a sidebar/read-state correction; it
is not used as evidence for transcript ordering.

## Ordering and scroll evidence boundary

The September 7 evidence already records the mixed-sequence work-log RED behind the Claude report
that newer tool activity appeared above an older compaction row. That causal-sequence correction is
part of 0.12.3.

A later virtual-list proposal attempted to follow synthetic work rows when the viewport owned the
tail. Its 18-test browser file passed unchanged against released 0.12.3, so it did not reproduce a
release regression. Those source and test changes were removed from this corrective candidate. No
new transcript-scroll fix is claimed from that passing control.

## Packaged diagnostics and native QA

The bounded chat, sidebar, and queued-action diagnostics are now available in packaged builds.
They retain lifecycle identifiers, states, sequence frontiers, and action kinds, with a 500-sample
limit for queued actions. They do not retain prompt or attachment content.

In a fresh Penkra Dev desktop run, a normal long response was started, a follow-up was queued, and
Steer was selected. The steering message and marker appeared while the turn remained active. After
switching to another Thread, neither was present there; returning to the origin showed both. The
turn later completed and the Stop control disappeared.

Computer Use also produced automation-only failures: one accessibility-state read timed out, a
clipboard paste timed out, and stale ScreenCaptureKit/accessibility targets were observed after
window changes. These are retained as harness limitations and were not converted into product
latency claims. The renderer's canonical state was inspected separately after the timeout.

A second fresh Dev run exercised the combined release source after integrating the Base-host and
launcher work described below. The initial prompt appeared with `Thinking` and the Stop control.
While the turn was active, a follow-up entered the queued state; selecting Steer produced the exact
message and its `Steering conversation` marker in the first measured post-click sample. The exact
message was absent after navigating to a different Thread and present once after returning to its
origin. That comparison Thread already contained an older steering marker, so marker absence by
itself was rejected as an invalid cross-Thread assertion. After completion, the origin sidebar row
reported `data-work-status="idle"`, had no active animation, and the transcript exposed neither
`Thinking` nor Stop.

The Codex Computer Use REPL listed the fresh `Penkra Dev` application as running, but two native
accessibility-state reads timed out. Live desktop-renderer automation was used for the interaction
evidence above. One navigation script contained a JavaScript parse error and another used a stale
pre-title-generation selector; both failed before their intended observation and were corrected,
not counted as product failures or passes.

## Recovered host changes and browser identity

The release audit found two completed but unmerged commits on the active Base-host branch. They add
the current-Thread read/compose/send bridge, the App-level `agentAddressable` boundary, and Penkra
Dev orphan-process recovery. All 33 source files were integrated into the release line. Conflicts in
the desktop command pipe and main-process assembly were resolved by retaining both these APIs and
the current multi-window shell registry. Focused verification passed 26 server App-runtime tests,
20 SDK tests, and 47 desktop host/policy tests.

That integration exposed a released-source inconsistency in browser user-agent policy. The 0.12.3
tests required the Penkra product token for ordinary and lookalike hosts and removal only for the
exact WhatsApp host, while the source removed it globally before URL-specific policy ran. The
shared URL policy now keeps the general product token and strips it only for the exact
`web.whatsapp.com` exception. This correction was accepted only after the focused integration test
failed on the unchanged behavior.

## Reopened Thinking and sidebar handoff gap

A fresh 0.12.4-source Penkra Dev replay reopened a lifecycle gap that the September 7 evidence had
claimed closed. The first high-frequency DOM run began from a stopped provider session. Thinking
and Stop appeared with the sidebar running, the sidebar then returned to idle, and Thinking and Stop
later disappeared before the authoritative running projection restored all three. The probe initially
treated that temporary Stop disappearance as completion and ended too early. Its result is retained
as harness evidence only; the corrected probe requires an observed running turn followed by an
authoritative completed turn.

The corrected unchanged-source run reproduced a 674.5ms sidebar idle interval. The shared local send
owner ended at renderer time 254949.7 while the admitted message id was not projected until 255393.2;
the sidebar still returned idle because it compared that new pending message against the unrelated
previous completed turn. Authoritative running arrived at 255616.4. A separate stopped-session trace
showed the transcript gap: `hasServerAcknowledgedLocalDispatch` treated the provider's stopped-to-ready
bootstrap as acknowledgement even though the latest turn remained the previous completed turn.

Two controls encoded those exact states against unchanged source. Both failed: the chat predicate
returned acknowledged for stopped-to-ready, and the sidebar returned Completed for a new pending
message with an older completed latest turn. The correction accepts only evidence tied to the new
dispatch—a changed latest turn, running phase, blocker, or explicit error—and treats a non-null
`pendingTurnStartMessageId` as work without consulting the previous turn's state. The content-free
sidebar lifecycle recorder is also enabled in packaged builds and bounded to the active or live
threads, rather than walking every idle sidebar row.

History isolates the two regressions. Commit `b1b4767b5` (`Refine working timer bootstrap handling`)
introduced acknowledgement on a session-orchestration transition, while commit `852c8b9a9`
(`fix: harden thread lifecycle recovery and observability`) introduced the pending-message comparison
against `latestTurn.state`. The local-dispatch acknowledgement mechanism itself originated in
`00b2b1e02` (`Map Codex stderr errors to warnings and track local send ack`).

After correction, 187 focused chat/sidebar/diagnostic tests passed. A fresh native replay starting
from an interrupted session observed Thinking, Stop, and sidebar running continuously from 228.9ms
through the first assistant stream at 5361.5ms and final settlement at 10153.8ms. No intermediate
idle or hidden state occurred. The unchanged RED artifact is
`.penkra/qa/lifecycle-gap-20260909/result-red.json` (SHA-256
`8b6e6f0e5153a4748496b9910c4d4e3639b1ba9d0273ce895362f3469aab936c`); the GREEN artifact is
`.penkra/qa/lifecycle-gap-20260909/result-green.json` (SHA-256
`628b95ebb4a9e4c0ef80e344553ec3cd2bdb68262efcc23c70b96baf636ac3d9`).

The first DOM probe used epoch time against `performance.now`, producing negative relative values,
and a prior inspection command referenced browser `location` outside `page.evaluate`. Neither result
was used for timing or product acceptance. The corrected probe uses the renderer clock consistently.

## 0.12.4 candidate verification

The final combined `bun run release:verify` passed every stage in 504.4 seconds: brand identity,
formatting across 2,634 files, lint, type checking, migration lineage across 120 release tags,
release smoke, the full unit/integration workspace, production build, React compiler contract, and
both browser partitions. Lint exited zero with 519 warnings and no errors. ChatView passed 120 of
120 browser tests; the component partition passed 219 of 219 tests across 43 files. The build
retained existing advisory messages about stale Browserslist data and large output chunks.

The production required-App check reports `com.penkra.apps` 0.2.9 as published at package digest
`5c35556b7fece4d3694b4959f3143a47ec7236ae05dc5f0beb2e2d8778a81f52`, exactly matching
`required-apps.lock.json`. The approved desktop version is 0.12.4 and the candidate lockfile SHA-256
is `ff8925c6983d8d2881e4a2657838fa4ad1e6ed52b45e87089cb53b19aa5120cf`.

The first local package attempt was rejected because the active sibling Apps checkout was not at
the locked commit. A detached worktree was created at the lock's exact source commit without
altering the active Apps work. The next attempt correctly verified that commit but pointed at the
repository root rather than its `apps` package and failed because no root manifest exists. The
corrected exact-source arm64 ZIP embedded the expected Apps digest, completed Developer ID signing
without publication notarization, regenerated its differential blockmap, and passed the isolated
packaged-desktop startup harness. Publication, tag identity, release assets, updater metadata, and
installed-update acceptance remain unverified until the exact source commit completes the protected
release workflow.
