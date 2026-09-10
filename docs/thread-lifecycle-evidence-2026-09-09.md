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

## Send tail jump and Stop latency follow-up

The supplied 42.665-second recording was sampled at 20 fps across 19.00–20.10 seconds. Its transcript
scrollbar moved from y=659–782 to y=931–1054 in one frame, then corrected upward through y=908,
891, and 886 before stabilizing. The contact sheet is
`.penkra/qa/send-jump-stop-20260909/video-19-20/contact.png` (SHA-256
`9bf031fcaef94446ec7560ef9915e0c78cf2d6717fa2dbcdd18f9135109f475f`).

Two unchanged-source live controls isolated the writers. With explicit reader ownership, Send used
native smooth scrolling for about 1.4 seconds across the virtualized transcript, moved over 34
sampled frames, and included one 1,972.5px frame jump. With stale tail ownership, the imperative
scroll and list correction competed: the first correction moved 4,123px and a later correction
reversed 4.5px. The first artifact is
`.penkra/qa/send-jump-stop-20260909/scroll-reader-detached-red.json` (SHA-256
`0ac36a0066f3b146ed859beb37ada6a314ba8eb42b8ec6007eddb6152b8ffef9`); the second is
`.penkra/qa/send-jump-stop-20260909/scroll-detached-red.json` (SHA-256
`d4e7def57e4773954deb4d7a64cd63e0a753c39b0c9f9da50fda148724dce464`). Commit
`0e38b1bee` introduced smooth Send following on 2026-06-28. Commit `f01a006ff` removed other
scroll-owner races on 2026-09-04 but retained this call and its browser assertion.

The browser control was changed first to require an atomic Send placement and failed against the
unchanged implementation (SHA-256
`42cf0c609396395bec3967f18ccafd3679f8d74648ec8db38a24308d0ecf3e3f`). Send now arms the
same causal-tail ownership without browser smooth behavior. The rebuilt native replay made one
intentional tail placement, with no multi-frame motion or reversal
(`.penkra/qa/send-jump-stop-20260909/scroll-green.json`, SHA-256
`3756361f0ef8fc79022cb99b6673fa9e5bd7fdb8c793eeb0d18a865f15114bb4`).

Stop has two distinct latency boundaries. In an active Codex tool sequence, the unchanged build
accepted the orchestration command in 3ms, requested provider interrupt 8ms later, received provider
acknowledgement 6ms after that, and cleared the UI in 440ms. A separate pre-acceptance run reproduced
a startup race: Stop was accepted, no provider turn interrupt existed yet, and session startup
continued through thread resume before its stopped preflight unwound. That log is
`.penkra/qa/send-jump-stop-20260909/stop-preaccept-red.log` (SHA-256
`2d4484a590304ded370a799b45ae6a8e07016c06009ea77843193d54ce97b936`).

The structural delay was in `runCurrentUrgent`: since commit `35ccf57b9`, an interrupt could wait
five seconds behind the per-thread provider lifecycle lock before using its already generation-checked
bypass. A deterministic contention control timed out at 5,003ms on unchanged source (SHA-256
`9da8258472cfec2c238f51d241d0222b7cff7463e4ec7338e6b95dcd0d515bf1`). The wait is now one
100ms scheduling window; generation validation and the bypass remain unchanged. Renderer lifecycle
diagnostics now record interrupt dispatch, durable receipt sequence, and dispatch failure, while
server/provider logs retain command receipt, admission, provider request, acknowledgement, and
terminal projection.

The rebuilt active-tool replay recorded renderer interrupt receipt 75ms after dispatch, provider
request and acknowledgement 7ms apart, and UI settlement 389ms after the click
(`.penkra/qa/send-jump-stop-20260909/stop-green.json`, SHA-256
`9d825d61843abd0d6e6bfe97eab958c38f7266718ef98f689cb99081bd00a8fe`). A stop issued 119ms
after Send during draft promotion settled in 1.062s without reopening
(`.penkra/qa/send-jump-stop-20260909/stop-preaccept-green.json`, SHA-256
`6a1d5e7836cac186671694908885be30aed6f0276261e3d2b01dc3f95de4ac9e`). This path includes
thread creation, hydration, durable interrupt admission, and authoritative pending-start recovery;
the trace keeps those intervals separate.

The initial browser RED command was launched from the repository root with the web Vite config and
failed before collection because the router generator resolved the wrong `src/routes`. It was rerun
from `apps/web`; that harness error is not product evidence. Pillow was unavailable during the first
pixel-analysis attempt, one shell probe overwrote zsh's reserved `path` array, and an early Stop probe
looked for the wrong timeline-row kind. None of those outputs were used for the conclusions above.

Post-fix validation passed 139 provider lifecycle/reactor tests, all 120 ChatView browser tests,
11 of 11 TypeScript tasks, formatting across 2,634 files, and lint with zero errors (519 existing
warnings). The rebuilt native controls above supply the behavioral acceptance evidence.

### Corrected tail-status insertion investigation

The atomic Send placement above was necessary but did not close the full regression. A subsequent
36.098-second Penkra Dev recording reproduced a different reversal when the optimistic user row was
already placed and native working/status rows entered the transcript. A current-commit replay on
`155bbb14d` used the retained 13-message, 46-activity Thread with heterogeneous measured row heights.
When the real 37px working header replaced its 90px estimate, TanStack's end anchor applied a
`-53px` correction and Penkra's causal-tail correction then applied `+90px`. Both writes reached
separate animation frames. The RED trace is
`.penkra/qa/send-jump-stop-followup-20260909/exact-thread-replay/result.json`; its captured geometry
is sufficient evidence for this boundary even though an isolated synthetic list did not reproduce
the painted reversal.

History identifies the incompatible ownership combination. Commit `eb0717ddd` enabled TanStack end
anchoring for semantic appends on 2026-08-27. Commit `f01a006ff` added Penkra's measured causal-tail
owner on 2026-09-04 and disabled the normal above-viewport adjustment while following, but
TanStack's special end-anchor adjustment bypassed that policy. Tail appends therefore had two
geometry owners. TanStack end anchoring is now limited to leading history prepends; Penkra alone
owns append and streaming-tail alignment.

The full-app matrix exposed a second boundary before acceptance. A detached reader inside a newly
mounted 1,285px streaming row could be mistaken for being below that row because the virtual
estimate still placed its end above `scrollTop`; measuring it then adjusted by `+1,195px` and
clamped to the live end. Conversely, an offscreen Markdown row changing from 48px to 304px must
still adjust the viewport to preserve the visible keyed row. Reader anchoring now records the first
visible semantic row, rejects a DOM rectangle whose size differs from its last committed
measurement, and falls back to the virtual offset lookup during a stale rendered range. Packaged
diagnostics record the DOM candidate, estimated candidate, chosen index, and whether an uncommitted
resize caused the fallback.

The final replay was performed only after reinstalling Penkra Dev 1 from this checkout. The earlier
launcher still targeted a separate desktop checkout at commit `5adc95ce4` and held a deleted
temporary Apps path; its apparently green replay is withdrawn as changed-source evidence. The
correct launcher uses durable paths for this desktop, backend, website, and Apps checkout. In the
true changed-source replay, 106 screencast frames and 219 animation-frame samples showed `+113.5px`
for the optimistic user row and `+37px` for the measured working header, with no negative
virtualizer adjustment or reversal. Removing 75px of temporary work UI caused the browser to clamp
by 58.5px to the shorter document end while retaining the visible bottom. The final result is
`.penkra/qa/send-jump-stop-followup-20260909/exact-thread-replay-final/result.json` (SHA-256
`1d1a1b1147d7f5f5932d469b5971067c86e6002e13c0c18f3001f967669772d0`); the pixel contact sheet is
`.penkra/qa/send-jump-stop-followup-20260909/exact-thread-replay-final/contact.png` (SHA-256
`ee8d4bcad9dc4acfdf4161f31159e9e6914b533d8efe5372ce011536b33a8308`). The full-app ownership
contract fails when the previous semantic-append end owner is restored
(`.penkra/qa/send-jump-stop-followup-20260909/full-chat-owner-contract-red.log`, SHA-256
`dab28537d0e596601525c0abab0be4cd5333ca379bd4e6aebb6fbf40cf809e66`). Focused verification passed
17 virtual-list browser controls and 120 full ChatView browser controls.

The investigation retained its harness failures. The first final replay reached CDP before Dev was
ready. The Python contact-sheet script lacked Pillow and was replaced with FFmpeg. An initial
formatter call from `apps/web` failed to load the root Vite configuration and was rerun successfully
from the repository root. LaunchServices later returned success without starting Dev because the
launcher workspace referenced `/tmp/penkra-apps-open-qa.MmO1VG`; direct launch exposed the missing
manifest error. None of those results were treated as product passes or scroll failures.

## Composer ownership and terminal regrouping follow-up

The supplied Penkra Dev recording `Screen Recording 2026-09-09 at 8.51.20 PM.mov` has SHA-256
`45d5980277a4dde93d0d29731ba1a3a5041147fa7a7affc0405fa02576379505`. It records two distinct
ownership violations: the submitted prompt remains in the composer after the optimistic user row
and Thinking UI appear, and a completed turn temporarily renders its `Worked` disclosure among the
existing work rows before regrouping around the final assistant response.

The exact Dev thread was `1b5d9633-ef27-4b80-b9d8-0eb722a76a03`. Its retained event order for
“What have we done so far? Check” was user `thread.message-sent` at sequence 389362, start requested
at 389363, delivery accepted at 389364, provider running at 389365, assistant/tool activity at
389366–389390, final assistant streaming at 389393–389487, session ready at 389489, and
`turn.completed` at 389490. Admission took 428ms. This establishes that the prolonged composer
ownership was renderer-side and that terminal regrouping happened after native activity had already
been projected.

The Send RED control required the submitted text to leave the visible composer when preflight takes
ownership. Unchanged source failed while Thinking was visible and before `thread.turn.start`. The
terminal RED control observed DOM ownership across settlement; unchanged source created a second
node marked `data-settled-turn-collapse-transition="true"`. History showed that this was deliberate:
`useSettledTurnCollapseTransitions` retained a timed inert clone while the canonical rows changed.

Send preflight now captures one submission owner and transfers the visible composer synchronously.
Pre-dispatch failure or Stop returns that exact owner to an empty composer, or preserves newer typed
content and uses the existing paused queued-recovery path. Post-dispatch uncertainty remains durable
and does not restore automatically. Diagnostics record `composer-submission-claimed`,
`composer-visible-cleared`, and `composer-submission-restored`, including prompt length and clear
ownership. No timeout determines ownership. Settled turns now render directly under one terminal
assistant owner; the transition clone, timer, and animation-frame handoff were removed.

The final structural review found an adjacent attachment race. The immediate visible clear could
schedule IndexedDB image and file deletion before pending-start recovery captured its durable owner.
Composer clearing now has an explicit `preservePersistedAssets` transfer mode. Recovery settlement
releases those assets only after the store mutation, so restored content retains them while an
accepted or failed send deletes unreferenced assets. A direct asset-store control verifies the full
composer-to-recovery-to-settlement lifecycle.

The complete Chromium ChatView run passed 121/121 tests. Web unit validation passed 256 files and
2,516 tests before the final asset-lifecycle addition; its focused final rerun passed 30/30 unit
tests, and the two exact browser controls passed. Web TypeScript, the 187-test timeline/work-log
subset, task-file formatting, and `git diff --check` passed. Final repository gates are recorded in
the release handoff after this evidence section.

The accepted rebuilt Dev replay is `.penkra/qa/composer-terminal-grouping-20260909/live-dev/`.
`result.json` has SHA-256 `46d3ed134036e4ef18f6293090aafc9bc810f331099a6bfef6a157206dd6e07f`;
the composed, admitted, and completed frames have SHA-256
`2baebf1c218c47cdd201b72d3733acdb04b080d2a9b27f82769ba444d5a2e249`,
`27ca7dc1cfdaff53d18153f0abd45dde8a5a7cb437a85982df962c7b71d283ea`, and
`21984c99d43427456a552313dd354d54486653be4f331e2169ce42950cbf976a`. Across its painted
animation-frame samples, `overlapFrames=0` and `duplicateOwnerObserved=false`. The sequence moves
from composed prompt, to empty composer with Stop, to empty composer with Thinking, to one terminal
`Worked` disclosure and the final response.

Several probes were rejected as evidence. The first browser command named a nonexistent config. The
live Dev database required an offline copy because Electron held an exclusive lock. An early live
probe matched “Thinking” in a sidebar title, MutationObserver captured unpainted reconciliation, and
stale animation-frame loops from prior runs wrote into a reused buffer. The accepted replay reloads
the page to destroy prior observers, samples once per animation frame, and uses the exact visible
working-row selector and geometry. A later focused unit command passed file paths to Turbo as task
names and collected no tests; it was rerun through the web package's Vitest entrypoint. None of the
invalid probes were counted as product evidence or a passing gate.

Final verification on the frozen source passed 121/121 Chromium ChatView tests, 256 files and
2,516 web unit tests, all 11 repository TypeScript tasks, and repository lint with zero errors (523
existing warnings). The first root typecheck exposed widened `queryMode`/`order` values and an
unmapped transaction error in the separately committed transcript-discovery implementation. Those
release-blocking errors were corrected with literal annotations and the repository's existing
`ProjectionRepositoryError` mapping; its focused gateway/query suite passed 65/65 before the full
11/11 typecheck rerun passed.

The first production build then exposed a separate React Compiler contract failure in `ChatView`.
The exact dependency fix already existed as reviewed commit `8c9864c26` on the integration branch
but was absent from `main`; its value snapshots and whole-object dependency were applied unchanged.
The web production build then passed, including all four compiler hot-path contracts. One attempted
rerun failed before build startup because a root-relative formatter path was supplied from
`apps/web`; it was separated into a root formatter invocation and package-local build and was not
counted as a build result.
