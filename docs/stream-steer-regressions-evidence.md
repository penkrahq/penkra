# Production reasoning and queued-Steer regressions (2026-10-13)

## Observed system and causal boundaries

Installed local Production was 0.14.4, ASAR SHA256
`65629b09fda2e918597f4eb8d02f2411e4e6d10cf9dadb28dcc29cba43c53fd0`.
Registered live backend reads identified the screenshots, without opening a live database:

- `agent-402e5d680a563c2a44088edcc10a1339`, “Penkra 0.14.4 clean rebuild (GPT-6.1)”: distinct native Codex reasoning IDs had literal `Reasoning` text alongside a genuine “Assessing commit messages” summary (seq 11167). The bridge introduced lifecycle-title-as-content in `8c74a538a6`.
- `477ace2d-1347-49be-a074-0d2e03c9c189`, “Strategy”: successive thinking chunks, including “Found it — the engine au” (seq 26236), had separate event UUID source IDs. Claude thinking deltas lacked block identity; the bridge used event IDs. This bridge path also entered in `8c74a538a6`.
- The queue admission in `721409f8d2` returned early for an existing message regardless of dispatch mode. The only nonempty queue at investigation time was “Let's take over the discussion from”, but that does not establish which exact user click failed. Controlled reproductions prove existing queued Steer returned `queue` for running and idle threads.

## Ownership corrections

- Lifecycle updates for text/reasoning contain only actual provider-authored detail, never a lifecycle title. Missing text means a status-only update. Explicit null still clears text. Canonical upserts preserve already-streamed text when the content field is absent, including the sidebar preview.
- Empty reasoning records remain valid internal lifecycle state but do not produce work rows. Authored text literally equal to “Reasoning” is not filtered out.
- Claude owns one item ID per thinking block. Deltas share that ID; block stop completes it. A new API message resets the block-index namespace. A missing block stop does not fabricate completion or merge into the next message; canonical turn cut-off settles unfinished items.
- Ordinary duplicate queue admission remains idempotent. Steer on an existing queued message admits the stored payload using the existing native-steer / interrupt-deliver / idle-deliver policy. Waiting queue entries cannot block explicit promotion; an already-admitted idle start still does. Promotion never clears an unrelated composer draft. Queue entries stay saved until native acknowledgement and retain their order on rejection.

No timer, proximity/text heuristic, string-based historical repair, new UI, migration, version change, provider fork or compatibility route was added. Historical malformed rows are not rewritten by inference.

Claude block boundaries were checked against the primary streaming contract:
https://platform.claude.com/docs/en/build-with-claude/streaming

## Acceptance evidence

Before implementation: six server assertions and one web assertion failed on the reported mechanisms. The first block-index implementation also failed a deliberately missing-stop / next-message-index-reuse test; the final message boundary correction passes it.

One neighboring test caught an overbroad idle-steer queue bypass. The correction applies bypass only to a message already in the queue; the original failed-head / ordinary-send behavior remains tested unchanged.

- Focused server/provider matrix: 7 files, 218 tests passed, 32.90 s. Includes native Codex/Claude, same/different account, direct/already-queued dispatch, attachment rollback, non-head provider rejection, acknowledgement and duplicate admission.
- Clean-core plus migrations: 23 files, 180 tests passed, 64.26 s.
- Web mapper, item store and transcript logic/rendering: 4 files, 121 tests passed, 25.70 s.
- `bun fmt`: passed. `bun lint`: 0 errors (518 pre-existing advisory warnings). `bun typecheck`: all 11 tasks passed; final changed-test verification took 5.977 s.

Signed complete local 0.14.4 candidate built from `4eb7a962b2308d731477f7bcaa62e03dd4fca8b0` plus the recorded working-tree fixes, including the earlier Main-folder pagination change. Required App source was pinned to `93b2ae9a1d0bc5285d357e317c3d5d4dea742cfe`. `codesign --verify --deep --strict` passed. Candidate ASAR SHA256:
`a54339e4635fca8d4c5b193cc4b5547b2b22df97f4b8924aad343cd85ec7a481`.

## Live acceptance found a shared-backend CPU loop

The first local swap completed (`updates/20261013-104235-870078/report.md`, `UPDATE OK`). Production PID 33585/backend 33597 initially answered shell reads in 4–6 ms. During subsequent user activity, native Computer Use observed `Loading conversation` and `cleanCore.sendMessage` timeout; an isolated QA send also could not finish. Backend CPU reached 113.3%, and even `/status` stopped answering within a bounded 3-second diagnostic request.

A native process sample and a transient localhost-only Node debugger captured the running JavaScript stack without reading locals or credentials:
`setThreadDraft → publisher.publish → waitForPendingAdmission → SELECT sending → Deferred.await`.
The sender's Deferred callback resumed synchronously inside Set iteration, removed itself and subscribed again. A second subscriber kept the same Set alive, so the publisher continually visited the new subscription in the same notification. This starved the shared event loop, including unrelated chats and HTTP. The waiting sender entered in `721409f8d2`; the live-Set publisher entered in `680e1da77f`. The three targeted fixes did not introduce either path.

A bounded reproduction threw after the fourth duplicate callback instead of hanging the test process; it failed before the central publisher correction. The publisher now visits a snapshot of each subscriber set, while checking membership to preserve explicit unsubscription. No new subscriber is revisited within that notification. The same helper covers thread, global, sidebar and provider notifications. No polling, scheduling delay or thread-state guess is involved.

The neighboring subscription-lifetime test also reproduced old unsubscribe cleanup erasing a replacement listener set. Cleanup now removes the thread's registry entry only if it still owns that entry. The publisher/sender/change-stream matrix passed 39 tests (9.92 s), and lint/typecheck passed after both corrections. An intermediate signed candidate without this last lifetime guard was not installed.

Final clean-core/migration/Claude pass after the publisher changes: 24 files, 305 tests passed (51.50 s). The callback-membership approach was compared to the standard snapshot-dispatch rule, which also allows removal during dispatch: https://dom.spec.whatwg.org/#concept-event-listener-invoke . This is an architectural reference, not a claim that Penkra implements DOM propagation or listener-token semantics.

The stalled app was quit through its native menu shortcut; desktop logs recorded shutdown completion at 16:54:01Z. That also closed the temporary debug listener (port 9229 confirmed closed). No database was edited or read while running. The final signed candidate includes both corrections; the first swap is not a claim that live QA passed.

## Separate Dev startup finding

Dev 2 was refreshed through the canonical numbered launcher installer, using the current checkout and existing workspace repositories. The backend at port 57751 returned `/status` version 0.14.4, migration `ok`, and `/health` startupReady true. Desktop bootstrap stopped at “backend start requested”. `ServerListeningDetector` waits on `Listening on http://`, while the running server emits `Penkra running`; no matching line arrived. Native Computer Use could not obtain a Dev window. This is not passing Dev visual QA.

The packaged startup owner opens the window immediately (`initialBackendWindowOpen.ts`); Dev explicitly waits on the log detector (`main.ts`). No readiness workaround was added to these fixes. An explicit child-to-parent readiness protocol is a separate architectural direction requiring discussion.
