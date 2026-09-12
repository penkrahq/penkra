# Desktop and Thread lifecycle evidence, 2026-09-12

This records reproduced mechanisms and validation in the isolated four-window investigation
checkout. These changes were not applied to the running Production app. Active work is tracked
only in the repository-root ignored `TODO.md`.

## Answered question remains after restart

Production Base App (`78be0300-d47e-472f-b9a0-23afaf6abb0e`, Codex) retained request
`c80f4474-afee-454d-8e1f-e8cc5d663794`. Its source timestamp was 00:09:36.931Z. Startup
reconciliation at 04:21:19.523Z reported zero unresolved interactions. The question subsequently
appeared at orchestration sequence 2985234, after the post-reconciliation snapshot at 2985077.
Answer attempts at 04:52:39.547Z and 04:52:43.592Z reached the backend and failed with
`no persisted provider binding exists`; both settled as retryable. The session was interrupted
and had no active provider turn. No answer was resubmitted during the Production inspection.

The controlled reproduction journals a request without projecting it, settles the session as
interrupted, and starts runtime ingestion. The old request becomes actionable after startup
cleanup has already run. Six cases failed before the correction: question and approval requests
for Codex, Claude, and OpenCode. Six corresponding live-session controls passed.

The correction checks request ownership before projecting a replayed request. An obsolete
generation, or a retired session without a live owner, produces an expiry activity containing
the question instead of recreating an actionable request. The original provider event remains
in the runtime journal. Expiry commands have deterministic identities and use the existing
`PENDING_INTERACTION_NOT_FOUND` settlement contract. Current owners are preserved even when the
shell still reports an interrupted session.

A second reproduction seeded a successor question with the same request ID before replaying
the old generation. All six cases failed with the initial correction: projecting the old request
before expiring it could remove its replacement. Checking ownership before the request projection
corrected that problem. The expanded matrix covers 36 provider/request/ownership combinations.
The complete ingestion suite passes 151 tests.

The provider-service reproduction separately verifies the missing-owner response path. It failed
before the service supplied a typed interaction-not-found code. Missing bindings, inactive
runtimes, and stale generations now identify an unavailable interaction; ordinary validation
failures retain their existing classification. The reactor preserves submitted answers in its
failure activity and does not manufacture a successful provider response. The complete provider
service and command-reactor suites pass 205 tests.

## Expired-question recovery

The composer distinguishes expired questions from actionable requests. “Review follow-up” puts
the original question and available answer into the composer for review. It does not send a turn
or respond to the dead request. Existing draft text is preserved. Missing answers are visibly
marked for the user to supply. New request generations do not inherit old recovery content.

Thirty pending-input and recovery unit tests pass. A real-browser test verifies retained draft
text, the question–answer content, and zero turn-start or question-response commands after review.
The browser run also rechecked the six delayed-admission media cases and the frame-sampled
message-order control: eight tests passed.

Native QA used isolated Dev2, renderer port 5734, with its own backend and state root. A real
Claude Sonnet question in Thread `0bb85d7c-5435-4d73-8a0b-21ec4b77431b` was pending at
05:24:07.159Z. Only Dev2 was quit, through its UI. After reopening the rebuilt instance, the old
options were gone, “Question expired” was visible, and the composer was available. Reviewing the
follow-up left backend sequence 8162 unchanged and pending interactions empty. A subsequent
explicit user turn received a completed workshop schedule.

An automation error during that QA typed a newline as Enter and submitted the question line
before the answer. The state was inspected before continuing; the complete answer was then
submitted explicitly. This is not evidence of an automatic-send defect in the recovery button.

Production main/backend 53985/54036 and Dev1 main/backend 77230/77233 remained unchanged during
this native QA. Inspecting an already-closed Dev2 through the computer-use handle launched an
empty Electron shell; that shell was closed before the intended Dev2 launcher was started.

After the final reused-request-ID refinement, another fresh Dev2 launch verified the live-owner
control. Claude requested audience selection at sequence 8320, request
`95ab11f5-0d99-47f3-bb09-d5b3df71f9bd`. Clicking Engineers resolved it at sequence 8323,
removed the question card, and produced a completed workshop response at sequence 8433.
The final formatting, lint, type-check, and whitespace checks passed; lint reported 535 warnings
and zero errors.

## Steering and media

The pending Steer projection introduced in `058076636` copied text but omitted attachments.
Holding initial turn admission, queueing an image, and clicking Steer reproduced a marker with
no image preview for all three provider selections. The ordinary-send attachment builder is now
shared with the pending Steer projection. Six image-only/mixed-text provider cases pass.

Native Codex QA in Thread `7f42ecdb-95c7-42bc-a3a6-e35e758ae9ce` displayed the steering marker
and an actual PNG preview together, retired the queue row, and completed the provider response.
The visible “(No Content)” was the pre-existing image-only placeholder, not a duplicate message.
The controlled queue row remained disabled while its claim was pending; a duplicate actionable
Steer row was not reproduced in that flow.

The separately reproduced restored-queue no-op and marker flicker are covered by the earlier
investigation evidence. The fixes respectively move the local-draft guard after authoritative
server acceptance detection and preserve `dispatchMode: steer` during the queued-steer event.

## Unexpected desktop exit

Production's 00:10:04Z exit was process exit 7. Its last browser session-close log preceded the
system exit handler by 23 ms. A native Electron reproduction using public browser-manager methods
throws when cleanup reads `webContents.debugger` after destruction; the original handler then
exits 7. Guarding destruction before that access makes the same native probe exit 0. The later
ownership/destruction checks remain intact. The exact exception thrown in Production is unknown.

An `uncaughtExceptionMonitor` records the fatal stack synchronously before the existing fatal
handler runs. Disposable child-process tests prove that logging preserves the original exit
behavior. The browser-manager and fatal-error suites pass 29 tests. The read-only Production exit
observer continues following relaunches; it does not signal the app.

The observer recorded another Production main exit 7 at 08:38:35.981Z, with backend exit 1
at 08:38:37.009Z. Production relaunched externally as main 47765/backend 47769. Before that
exit, the desktop log recorded a browser `ERR_CONNECTION_REFUSED` at 08:38:32.713Z and a
`webContents.goBack` deprecation warning at 08:38:34.715Z. No fatal exception stack was retained.
This sequence does not establish that the earlier destroyed-debugger mechanism caused this exit.

## Other observed evidence

The reported transient movement of “Cool” is not reproduced. Persisted ordering and a replay of
the actual historical messages/work entries put it after the preceding user turn. A browser test
sampling bubble geometry each animation frame also preserves order. No ordering behavior was
changed on that evidence.

Native Codex QA also stored an async question as assistant message `assistant:call_9mvDRndG1f8nVL90vgSZsF0B`
at sequence 8122, followed by the final waiting message at 8126. The native view displayed the
final message while the question was folded into the completed-turn disclosure. The provider's
own rollout records `request_user_input_async` and an accepted response. This is separate from an
orphaned pending request; the snapshot contains no pending interaction for that turn. No behavior
change was made for this case.

The [official App Server documentation](https://learn.chatgpt.com/docs/app-server) describes
`item/tool/requestUserInput` and `serverRequest/resolved`, including cleanup on turn lifecycle
changes. The fetched documentation does not establish the behavior of `request_user_input_async`.

Formatting, lint, and type checking passed during validation. Lint reported existing warnings
but no errors. Reproduction harnesses and detailed diagnostic artifacts remain in the retained
investigation scratch root; they must not be mistaken for Production state.
