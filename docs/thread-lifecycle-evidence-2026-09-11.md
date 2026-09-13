# Multiwindow transport and provider failure investigation — 2026-09-11

## Scope and status

Production 0.12.6, initially four native windows: Base App, a local issue-report draft, and two views of Threads. The user subsequently restarted production, leaving two windows. Production was not patched or restarted by this investigation. Changes are uncommitted on `fix/multi-subscription-reconnect`, based on main `7dced9073`; four renderer files and three title-generation backend files were copied to the shared numbered Dev source for desktop QA. No release version was selected.

This is evidence, not a completion claim. Fresh Dev 2 at 20:58:34Z passed Free OpenCode startup, question submission in a peer window, Stop, and propagation back to the original window. Fresh Dev 3 passed Codex send and Stop. Claude returned a real billing error and settled the UI, but incorrectly recorded successful completion; its correction has automated coverage but is not yet manually validated. Live Claude interruption is unverified because its available API connection has insufficient credit. No pending production release-version question was answered. Heavyweight checks were not run because repository instructions require an explicit user request.

The 20:58 restart of all three Dev apps was caused by this investigation copying backend QA code into the shared watched source. `apps/desktop/scripts/dev-electron.mjs` watches `../server/dist/index.mjs`, so its rebuild restarts every numbered desktop sharing that bundle. Further backend changes remain in the isolated checkout. No production restart was performed by the investigation.

## Production evidence

- The issue-report draft `9cd2cd11-ce6d-4670-80b6-89e583ffc6e3` had no backend snapshot. Its renderer simultaneously recorded disconnected transport, zero server messages, no provider turn, one optimistic message, active local dispatch, busy composer, and Thinking. Six Stop actions had local dispatch records without a receipt or failure.
- In the exact production Threads thread `9808159a-4c06-4c61-a4d9-028bd2fe15b4`, a computer-use Stop click at 19:32:32.353Z recorded command `ce416251-1f43-407e-8924-9c3f26763ab6`. No receipt/failure followed and the command ID was absent from the main server log. A fresh backend read still showed a running turn awaiting user input. The renderer transcript ended around 18:32 while authoritative history extended to 18:57.
- The old Threads question was invalidated on restart. A resumed turn created a new release-version question at 19:48:03Z. Showing that pending question in both windows is not itself an error. Whether a submitted answer propagates and settles everywhere remains unverified.
- Console evidence includes repeated stale sync acknowledgements, sockets closing before establishment, and 60-second request timeouts. Backend health remained ready. A fresh Threads detail read took 15.4 seconds; a later Base App page took 657ms and full detail 1175ms. These observations distinguish connection/retry delay from the actual later page load, but do not prove whether navigation or an automatic retry triggered recovery.
- Base App had a real terminal quota failure: `usageLimitExceeded`, `willRetry: false` at 19:28:05.914Z, followed by failed turn completion at 19:28:07.715Z. After restart, its UI briefly failed to load and then hydrated with that quota error without a Try Again or Reload action. This quota failure followed the earlier transport symptoms, so it cannot explain the whole incident. New Threads usage was 1% after the user's limit reset.

## Reproduced transport defect

`WsTransport.reconnect()` cancelled active streams synchronously before publishing `reconnectPromise`. Cancellation can synchronously invoke stream exit handlers that call reconnect again. Multiple callers therefore created replacement runtimes and sockets, losing ownership of earlier replacements. Send and Stop both use command dispatch with no timeout and retry on reconnect, so this failure can strand both while the renderer retains optimistic busy state.

A real transport probe connected four clients to isolated Dev 2, each with seven streams matching the application's subscription set. It force-closed only its own sockets and attempted subsequent reads:

| Observation                                     |                     Original |            Patched |
| ----------------------------------------------- | ---------------------------: | -----------------: |
| Total sockets created after reconnect and reads |                           72 |                 16 |
| Live sockets after reads                        |                           24 |                  4 |
| Live sockets after disposal                     |                           20 |                  0 |
| Session version after recovery                  |                        10–11 |                  2 |
| Subsequent reads                                | Recovery multiplied sessions | All four fulfilled |

The fix publishes the shared reconnect promise before cancellation or state-listener callbacks and clears old stream ownership before invoking cleanup. The new regression failed on the original implementation and passes after the fix. A simple one-subscription probe had passed before the realistic subscription set exposed the defect; that earlier result was insufficient.

This establishes a transport defect matching the production symptoms. It does not establish that every historical stuck turn arose from this exact race. The affected transport file is unchanged between production tag `v0.12.6` and inspected main `7dced9073`, so the pending main changes did not already contain this fix.

## Free OpenCode picker defect

Read-only backend model discovery returned seven Free models. The Dev renderer's draft store retained `opencode-go/deepseek-v4-flash`, while its available anonymous route was `opencode`. The picker required the retained model prefix to match that route before discovering models, disabling discovery and displaying No matches.

The new shared discovery helper prefers the matching anonymous route and falls back to an available anonymous route for the same harness when the model hint is stale. This affects catalog discovery only; exact model authorization at send remains unchanged. Regression coverage verifies that a stale Go model discovers Free's catalog without authorizing that Go model, matching routes remain preferred, and Codex/Claude cannot borrow OpenCode routes.

## Provider coverage and research

The shared transport and interrupt admission paths apply to Codex, Claude Agent, and OpenCode. Source inspection confirms the interrupt reactor settles explicit rejected interrupts and escalates uncertain/time-limited interrupts to full session stop. An older production exact-turn binding rejection must not be conflated with the later commands stranded before receipt.

- Codex: retryable errors preserve an active turn; terminal failures are paired with failed completion. The documented app-server contract includes usage-limit failures and interrupted completion after interrupt. [Official app-server documentation](https://learn.chatgpt.com/docs/app-server)
- Claude Agent: rate-limit notifications and warnings are distinct from terminal assistant/result errors. The adapter uses query interruption with a bounded wait. Newer interrupt receipt semantics must be checked against installed SDK versions before relying on them. [Official TypeScript SDK](https://code.claude.com/docs/en/agent-sdk/typescript), [API errors](https://platform.claude.com/docs/en/api/errors)
- OpenCode: the installed 1.x integration uses session abort. The adapter handles abort echoes separately from other session errors, and context-overflow compaction separately from terminal failure. V2 beta documentation was not treated as the installed contract. [Official SDK documentation](https://opencode.ai/docs/sdk/)

The four baseline adapter/service test files passed 372 tests with two skipped. They ran at host `09cf093cf`; main differs in some Codex manager/service code, so this is not a claim of current-main full provider validation. The isolated patch's transport and connection capability suites passed all 47 tests. Quota was not intentionally exhausted. Later live provider checks are recorded below; an all-provider live interruption matrix is not complete.

No live SQLite files were opened or copied. No production credentials, release approval, or provider settings were changed.

## Additional verified findings

- At 20:17Z, Auto-Select Saved Browser detail returned in 867ms, ready/idle with no pending interactions. Design Sequence Game detail returned in 578ms, with a new turn completed at 20:15:05Z. The latter also recorded a terminal usage-limit failure at 19:28:13Z before the user's reset.
- Current patch-checkout provider, pending-interaction repository, and sync-acknowledgement suites passed 383 tests with two skipped across six files. Frontend pending-interaction and store suites passed 157 tests across four files.
- Fresh Dev OpenCode startup reproduced an additional stuck Thinking cause: exact message `ea118aee-4ded-4d8d-bc3c-94b37af6eb3c` had authoritative failed delivery at sequence 1669, visible in the renderer, but local dispatch remained busy because neither session nor latest-turn state existed there. Stop received sequence 1672 in 89ms; the UI remained busy. This differs from the earlier stranded transport commands.
- History `7fc8a9664` and `2458bde6f` deliberately preserved startup indicators by removing session-only and message-presence acknowledgements. The additional fix recognizes only a failed delivery for the exact submitted user message. It does not treat queued, starting, steering, or accepted message presence as completion. Its regression failed before the fix; all 132 acknowledgment, preflight, and session tests pass afterward.
- The already-stuck desktop cleared Thinking and Stop after the fix while retaining its startup error. A fresh Dev 2 launch at 20:31:02Z and a new thread `4f8455d5-2d68-404b-b2ce-a99bb9a02502` reproduced startup failure and correctly returned to an idle composer without clicking Stop. Reopening that thread in a second window also showed idle state. Four native Dev 2 product windows were subsequently confirmed in the Window menu.
- OpenCode 1.18.30 fails inside the actual managed launch while creating its workspace table. The identical binary starts with both an empty isolated environment and Penkra's managed child-environment builder in a separate disposable state directory. Thus a universal binary failure is disproven. The concurrent title/conversation ownership defect was subsequently isolated below. No existing provider database was opened, copied, reset, or repaired.

## Auxiliary title state and live verification

`ProviderCommandReactor` passed the conversation's managed launch to title generation. OpenCode title generation starts its own server, outside the conversation adapter's pool, with the same native database path. The managed launch propagation was introduced in `b0180444a` (0.11.5). A native log for the failed conversation's generation identified the other session as `Penkra generateThreadTitle`; it was auxiliary title work, not an orphaned execution of the user's request.

The installed OpenCode 1.18.30 binary starts successfully alone. Two concurrently starting servers sharing a fresh database reproduced `database is locked`; separate native databases allowed both to become ready with empty stderr. The standalone error differs from the product's `CREATE TABLE workspace` surface, so those messages are not treated as identical.

The user approved separate disposable auxiliary state. Managed title requests now retain the exact model, installation, credentials, and credential profile but own disposable runtime directories. OpenCode gets separate database/data/state paths and a dedicated process that closes before cleanup. Codex retains its credential-bearing `CODEX_HOME` and uses separate `CODEX_SQLITE_HOME`; its command remains ephemeral. Claude's normal fallback-title behavior is unchanged, and dedicated Claude title requests cannot fall through to Codex. A process teardown defect retains auxiliary state because exit could not be proven. Sixteen tests across five title-generation suites passed.

Fresh Dev 2 thread `2d233975-2448-45aa-a343-a3bf28dec3c6` used Free Big Pickle. The first request was accepted at 21:01:34.970Z, provider startup completed at 21:01:40.185Z, and title generation succeeded. Four workshop questions appeared in both the original and a newly opened peer window. Answers submitted from the peer resolved the question. Stop command `e4fc3101-9ceb-4566-aa3d-24ddd41bb89e` was received at 21:03:04.223Z, accepted at 21:03:04.228Z, and the turn became interrupted at 21:03:04.746Z. Both windows subsequently showed the partial response, idle composer, no pending question, and no Thinking/Stop. Three product windows were open for this particular run; earlier transport probes used four clients and earlier desktop reconnect QA used four windows.

Dev 3 Codex thread `01d0b249-019b-45b8-8db0-a5b49d37a395` used the existing connection and GPT-5.6 Sol. The first request completed and generated a title. A longer follow-up started at 21:07:20.625Z and was interrupted by a UI Stop click at 21:07:28.141Z. Backend state was interrupted/idle, with no active turn or pending interaction.

## Additional provider failure defects

The OpenCode run quarantined an `item.completed` event at 21:02:56.398Z because its detail was `\n\n`. `ItemLifecyclePayload.detail` required trimmed nonempty text, despite carrying authoritative final message snapshots. Its schema now preserves strings verbatim, matching content deltas. New encode/decode tests cover whitespace-only, indented, and empty snapshots for Codex, Claude, and OpenCode. Baseline: three failures, seven passes. Patched: ten passes. This correction is not yet copied to the shared Dev build.

Dev 1 Claude thread `03115695-0851-4171-94c7-14054d965aac`, using Sonnet 5 and the available API connection, returned “Credit balance is too low” at 21:09:40Z. Native JSONL marked the assistant record `error: billing_error` and `isApiErrorMessage: true`. The UI settled, but the backend recorded completed/done with no runtime error. The native transcript does not contain the final SDK result envelope, so its exact `is_error` value was not captured.

The adapter's result classifier, unchanged since `77716b4cc` (March 19), ignored `SDKResultSuccess.is_error`. The installed SDK explicitly permits this boolean on success-subtype results. A regression with `subtype: success, is_error: true` reproduced incorrect completion; false remains successful. The correction marks true as failed and uses the SDK's result text as the error. All 373 tests across Claude, OpenCode, ProviderService, and runtime ingestion passed after these corrections. Live validation of the Claude correction remains outstanding.

## Isolated final-build four-window verification

The isolated numbered Dev 2 build started at 21:25:12.997Z (backend 71902), without a shared build watcher. Dev 1 (58280), Dev 3 (58279), and production (22175) remained unchanged. Thread `a1a5ad2f-3f48-4a22-8352-0cee09d42c57` used Free Big Pickle. The request was admitted at 21:26:24.432Z, started at 21:26:30.872Z, and generated its title successfully.

All four native product windows displayed the audience question. Answering Software engineers in window four cleared that question in the original window. The provider subsequently asked three new workshop questions; these were separate interactions, not the original question lingering. After answering those, a single UI Stop interrupted the streaming turn at 21:29:52.678Z. Backend sequence 1891 showed interrupted/idle, no active turn, no pending interaction, and no errors. All four windows independently showed the partial response and idle composer, with no Thinking, Stop, or answer submission UI.

After continuation, runtime identities and the settled thread were verified again. Navigation to the earlier workshop thread and back successfully restored both transcripts without a load failure or resurrected busy state. A fresh four-client probe with seven subscriptions per client closed all four owned connections simultaneously: each recovered once (session version 2), all four reads fulfilled, four sockets remained live, and disposal left zero sockets. This probe closed its own clients, not the four desktop sockets. Remote main was rechecked and remained `7dced9073cfeed5d3b798a3ba0c2bfdef13581e9`.

## OpenCode startup port allocation

A separate isolated run (`5a2f3628-6b07-452e-93a0-79e4fb9300fc`) failed to start its main provider at 21:21:10.090Z. Its selected port 64826 was already held by a production OpenCode process that predated this QA. That process was not killed. The runtime probed and released a port before launching the provider; this cannot reserve the port and the probe can use a different address family from the actual bind.

OpenCode now receives port 0 by default so the OS allocates its port at the actual provider bind. Explicit caller ports remain supported. The new regression failed on the old allocation behavior; 29 runtime/title tests passed after the correction. The subsequent four-window run above succeeded with this change. Its isolated launcher log contained no matched quarantine, auxiliary-state cleanup warning, or error entries. This does not establish that every historical load failure was caused by port allocation.

The auxiliary-state suite now also verifies that a process-finalization defect retains its state directory; all five ownership tests passed. The fixture removes only its own retained temporary directory afterward.

Restart persistence QA: quit only the isolated Dev 2 app using Quit and Keep Windows, confirmed its launcher exited and runtime file disappeared, then launched the same isolated build. New backend 75740 started at 21:37:03.548Z on port 65514 (launcher session 52069, isolated-dev2-restart.log). Production 22175, Dev 1 58280, and Dev 3 58279 remained unchanged. The restored product window opened thread a1a5ad2f-3f48-4a22-8352-0cee09d42c57 with its partial response, idle composer, and no pending question, Thinking, or Stop. No send or Stop was repeated.

## Final workspace checks

The user removed the explicit-request restriction for final checks. Both the host repository and patch checkout AGENTS.md now permit final formatting, linting, and typechecking without separate permission; passing checks remains required.

- `bun fmt`: passed, 2647 files.
- `bun lint`: passed, zero errors, 531 warnings.
- `bun typecheck`: passed, 11 of 11 tasks successful (seven cached), after repairing missing isolated-checkout dependency links. No manifest or lockfile changes were needed.
- Focused runtime/title regression rerun after dependency repair: 38 tests passed across four files.
- `git diff --check`: passed.

These checks validate the isolated patch; it has not been released to production. Live Claude interruption and live verification of the Claude error-classification correction are not established by these checks. The sole observed Claude connection had insufficient credit. Production has not received these patches.
