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

## Candidate verification

The final source verification passed formatting, type checking, the full Vitest workspace, and the
production build. Lint exited zero with 520 existing warnings and no errors; the prior baseline in
this task was 519 warnings, while changed-line inspection found no warning on the new sidebar code.
The web suite passed 2,514 tests. The build retained existing advisory messages about Vite/Astro
configuration, Browserslist data, chunk size, and plugin timing.

Publication, tag identity, release assets, updater metadata, and installed-update acceptance remain
unverified until the user approves an exact desktop version and the protected release workflow
completes.
