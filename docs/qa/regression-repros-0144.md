# Penkra 0.14.4 regression reproductions

Report only. Investigation started 2026-10-13 America/Denver; test logs use the host's timestamps. No fixes or product-code edits.

## Scope and evidence boundary

Read `docs/regression-audit-0144.md` and `.claude/skills/verify/SKILL.md` before running. Tested archived, tracked source at HEAD **8784c524a2954c61989fdabde7c5a5b93998890c** (contains 5897d4141) and v0.14.3 **445bc9b8c26bd6d1a657f7068e270d17da57599a**. Unrelated dirty files in the release worktree were excluded. No version files in that worktree changed.

Scratch root: `/Users/emmanuelgyekyeatta-penkra/Penkra/qa-0144-ns7tff4p`. Each snapshot has its own `qa-home`, `qa-providers/claude`, and `qa-providers/codex`. Databases were fixture-owned in-memory SQLite through Penkra's test client, never the Production database. Provider SDK/runtime methods were fakes; there were no real provider-account accesses, model calls, installation, signing, push, or publishing. Completed test cost: **$0**.

Tests executed real admission, dispatch, projection, persistence, composer-selection helpers, and Chromium presentation components. They do **not** establish upstream inference behavior. “SDK received” below means the fake at the real adapter's SDK boundary; “provider service received” means the fake used by real orchestration. No fake cache metadata is treated as a cache experiment.

Browser fixtures ran at explicit Vite ports 5899/5898 and browser API ports 5399/5398 with scratch `PENKRA_HOME`, `PENKRA_PORT=3899/3898`, server `VITE_DEV_SERVER_URL`, and web `VITE_WS_URL` configured. The browser suites supply mocked backend APIs rather than launching a live backend or desktop.

All durable evidence is in [regression-repros-0144/](regression-repros-0144/). `head/probes.patch` and `baseline/probes.patch` contain test-only additions and harness configuration changes for archived copies; they are not product fixes. Dependencies came from the existing installed checkout; test aliases point contracts/shared imports to each archived snapshot. No package installation occurred.

## Verdicts

| Case                                                            | Verdict                                                                  | Observed result                                                                                                                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Claude high → max and max → high on an idle existing thread | **Regression reproduced at orchestration/SDK boundaries**                | HEAD saves the new effort and sends that selection, but neither replaces the live session nor sends an SDK effort update. Baseline requests a replacement query with the new selection.                                                                    |
| (b) Claude/Codex progress and todo events in transcript         | **Regression reproduced**                                                | Baseline renders progress text and “Tasks updated”; HEAD's event bridge produces no item for either event.                                                                                                                                                 |
| (b) Task-progress panel/sidebar                                 | **Not reproduced as a new regression; intentionally absent in baseline** | Baseline full-view browser tests pass while asserting there is no task card/sidebar. A retained task-list derivation helper is not evidence of a visible checklist.                                                                                        |
| (c) Compacted state event without a compaction item             | **Regression reproduced**                                                | Baseline synthesizes and renders “Context compacted”; HEAD writes no marker. Compaction-item lifecycle remains a working control.                                                                                                                          |
| (d) New restart on public same-account model change             | **Not reproduced as stated**                                             | HEAD explicitly stops/starts. Baseline reuses a session only with a fixed binding revision; its public coordinator advances the revision, and that control also requests a replacement session. Actual native latency and cache changes remain unverified. |

## (a) Claude max-effort transitions

**Reproduction:** create an idle existing Claude thread with Opus 4.8 and effort high (repeat starting at max), save a draft selection for the opposite effort, and admit “Continue the release review.” Capture the picker-selection resolver, row before/after admission, session calls, SDK query spawn options, and live flag calls. Repeat high → low as the neighboring control.

HEAD real admission/dispatch with an in-memory DB produced:

| Transition | Picker-selection resolver | Row before send      | Row after admission     | Session calls | SDK boundary in a separate adapter probe                                                  |
| ---------- | ------------------------- | -------------------- | ----------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| high → max | max                       | high                 | max                     | send only     | Original `settings.effortLevel=high`; no `options.effort=max`, live flag update, or close |
| max → high | high                      | max                  | high                    | send only     | Original `options.effort=max`; no live flag update or close                               |
| high → low | low requested             | Adapter control only | Not separately captured | Live adapter  | `applyFlagSettings({effortLevel:"low"})`                                                  |

The real resolver independently returned `changed:false` for a same-model max selection and `changed:true` for a changed model. The coordinator test uses a selection fake matching those results; native materialization is stubbed to a retained session identity. Its draft/picker result is a **computed picker selection, not a clicked DOM picker capture**.

Baseline real Reactor tests requested two session starts for both max transitions, with the second selection carrying the requested effort and a retained fake resume cursor. This happens even without changing the binding revision. The independent baseline SDK probes demonstrate the same adapter restriction as HEAD: a live query alone cannot apply a max transition. The difference is baseline orchestration's replacement-query request. A fresh query's max spawn argument is captured by the max → high probe's initial spawn.

**What this proves:** on HEAD, persisted/pending effort and the provider service's turn selection can disagree with the effort configured in the existing SDK query. The next SDK turn has no observed mechanism to adopt max or leave max. Actual model reasoning effort upstream was not measured; no paid query was made. Picker DOM behavior and a single end-to-end DB-to-SDK run remain unverified.

Evidence: [HEAD admission trace](regression-repros-0144/head/QA0144_ADMISSION.jsonl), [HEAD SDK arguments](regression-repros-0144/head/QA0144_SDK.jsonl), [real resolver results](regression-repros-0144/head/resolver.json), [baseline admission trace](regression-repros-0144/baseline/QA0144_ADMISSION.jsonl), and each snapshot's `final-admission-effort.log`.

## (b) Progress and task lists

**Reproduction:** replay identical parent-thread events for Claude and Codex, one event at a time, with turn `qa-turn`:

- `task.progress`: description “Reviewing the release”, summary “Checked the desktop rollout”.
- `turn.tasks.updated`: “Inspect release” completed, “Verify runtime” inProgress, explanation “Release checks”.

Run each version's delivery projection and web work-log/task-list derivation, then render delivered work entries through the actual `TimelineWorkEntryRow` in Chromium. HEAD additionally runs its actual runtime-event consumer into an in-memory database. Native-adapter controls exercise Claude task-progress/TodoWrite handling and Codex task/reasoning chunks.

Baseline stores a `task.progress` activity with summary “Reasoning update” and detail “Checked the desktop rollout”. The actual row displays **“Checked the desktop rollout”**; it does not display the generic label. `turn.tasks.updated` renders **“Tasks updated”**, with no checklist in this row fixture. Its retained task-list helper returns both tasks and their statuses.

HEAD still receives the native events in adapter controls, but the bridge returns `[]` for both events, so the runtime consumer writes no corresponding item. The web receives no progress/task activity from these replayed events. The row screenshot contains neither progress text nor “Tasks updated”. This is a transcript projection regression for both providers; it is not evidence that all tool output or agent workflow cards vanished.

**Panel correction to the original audit:** baseline full `ChatView` browser tests “does not mount a task-progress panel above the composer” and “does not expose provider task progress for active turns” both **passed**. They assert absence of the active task card, completion-count text, and sidebar button. No new missing task panel is demonstrated. HEAD's equivalent full-view tests **failed before those assertions**, at “Active thread detail did not hydrate.” That failure remains uninvestigated and does not prove panel presence or absence. HEAD row-component presentation and server event persistence tests passed.

Evidence: [baseline event/output JSON](regression-repros-0144/baseline/events.json), [HEAD event/output JSON](regression-repros-0144/head/events.json), [HEAD persisted items](regression-repros-0144/head/persisted-events.json), [baseline screenshot](regression-repros-0144/baseline/presentation.png), [HEAD screenshot](regression-repros-0144/head/presentation.png), [baseline browser results](regression-repros-0144/baseline/browser.log), [HEAD full-view failure](regression-repros-0144/head/browser-panel.log), and `provider-controls-final.log`/baseline `provider-controls.log`.

Screenshots aggregate four independent event fixtures for each provider. The two compaction rows per provider in the baseline screenshot are separate state-only and item-only controls, not an observed duplicate-compaction bug.

## (c) Compaction without an item

**Reproduction:** emit only `thread.state.changed` with `payload.state="compacted"`, without `item.started`/`item.completed`. Run for Claude and Codex. Then emit a completed `context_compaction` item as the positive control.

Baseline synthesizes a `context-compaction` activity, and Chromium renders **“Context compacted”**. Its existing native-ingestion test for the state-only path also passed. HEAD's state-only bridge returns no events, and the actual runtime consumer persists no notice/item. No marker reaches the row renderer. The item-based control does persist and render “Context compacted” at HEAD.

**Verdict:** regression on the state-only event path. This does not imply all provider compactions lack a marker: any provider also emitting the context-compaction item still has the tested control path. Real provider frequency of the state-only variant remains unverified.

Evidence: the event JSON, persisted-item JSON, and browser screenshots linked in (b). The consumer probe checks empty rows after the state-only event and a notice after the item control.

## (d) Same-account model changes, latency, and cache

**Reproduction:** idle existing session; same provider/account/runtime mode; send a second turn with a changed model. Cases: Claude Sonnet 5 → Opus 4.8, Codex GPT-5.5 → GPT-5.6-sol, OpenCode Kimi K2.5 → GLM 5.1. Capture session lifecycle, selected turn model, persisted native identity, and time to dispatch.

HEAD coordinator + real TurnDispatch produced **stop → start → send** for all three. The native row IDs remain unchanged, and start receives the retained fake resume cursor and requested model. Native-state discovery is deliberately stubbed; this does not demonstrate successful real native resume. A separate OpenCode adapter probe receives `promptAsync.model={providerID:"openai",modelID:"gpt-5.4"}` and `variant="high"`. Claude's existing adapter model-override test passed and observes `setModel("claude-opus-4-6")`; Codex model-option tests passed and observe the requested model/effort/service tier at the manager boundary. These are wiring controls, not upstream acceptance claims.

The initial baseline direct Reactor probe holds binding revision 0 throughout: only one start occurs, and the second send has the requested model. **That probe does not represent the entire public switch path.** The baseline public coordinator's real test “journals a model-only change without cloning or verifying native state” passed and dispatches revision 5 from revision 4. Repeating the real Reactor probe with revision 0 → 1 produced **two starts** for Claude, Codex, and OpenCode, with the second carrying the requested model and retained fake cursor. Baseline source also shows `managedBindingChanged` forcing replacement; its adapters/managers tear down an existing context on replacement start. The latter teardown observation is source-read, not a new real-process measurement.

Thus the audit's blanket claim that public v0.14.3 model changes were in-session is not verified. HEAD moves the explicit stop into admission, but the public-shaped baseline control already requests replacement. No release-level added restart latency or new cache-loss regression is established.

**Measurements:** the undelayed HEAD fake runs dispatched in 0.644 ms Claude, 0.438 ms Codex, and 0.463 ms OpenCode. Injecting 50 ms into stop and 75 ms into start yielded 126.752, 128.643, and 127.460 ms respectively: increments of **126.108 / 128.205 / 126.997 ms**. This establishes that HEAD awaits both lifecycle calls. Those delays are synthetic, not observed native provider startup costs. Baseline fixture completion times around 0.3 s include asynchronous Reactor draining/polling and are **not comparable** to HEAD's synchronous dispatch stopwatch.

**Claude cache:** not measured. No real `cache_read_input_tokens` sample from a next turn was collected. Existing token-metadata fixtures establish token-field handling only; changing a model itself may affect cache eligibility, so restart alone is insufficient evidence of lost cache.

Evidence: [HEAD lifecycle/timings](regression-repros-0144/head/QA0144_ADMISSION.jsonl), [controlled latency run](regression-repros-0144/head/controlled-latency.log), [baseline binding-revision control](regression-repros-0144/baseline/binding-revision-control.log), [baseline traces](regression-repros-0144/baseline/QA0144_ADMISSION.jsonl), [OpenCode SDK request](regression-repros-0144/head/opencode-wire.json), and `head/provider-controls-final.log`.

## Paid/native verification boundary

Stopped at the real-account/model-call boundary as instructed. A subsequent authorized experiment would use separately authenticated scratch provider homes and fresh, matched threads on both versions; perform the same model transition; record monotonic selection/admission, native stop/start/resume acknowledgements, turn acceptance, and first response. For Claude, collect raw per-call input/output/cache-read/cache-creation metadata, not cumulative totals, with same-model warm-follow-up controls and a fixed cache lifetime. Model changes, system/tool prompt differences, and elapsed cache lifetime must be recorded before attributing any cache difference to restart.

A minimal two-version model-transition comparison requires four paid turns. With an estimated 6,000 input tokens per turn and 64 output tokens per turn, the uncached estimate is `0.024 × input_price_per_million + 0.000256 × output_price_per_million` dollars; cache writes/reads, actual host-policy overhead, and extended thinking alter it. Additional warm/cache controls require additional turns. No defensible dollar quote is available without the real selected models and account billing rates; fixture model names/catalogs are not a price source. No paid experiment was launched.

## Reproduction and validation record

Archive the exact revisions into independent scratch folders, link the existing dependency trees, and apply each evidence folder's `probes.patch` **only to its archived scratch copy**. Set scratch `PENKRA_HOME`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME`. The committed logs contain the exact `bun run test`/browser commands and selected test names. Probe JSON/JSONL files are written under that scratch home. Use `QA_STOP_DELAY_MS=50 QA_START_DELAY_MS=75` for the controlled latency pass. Browser replay inputs are embedded in the test-only patch; screenshots use the real row component.

Passing final runs: HEAD provider controls 13 tests; HEAD admission/effort 8 tests; HEAD delayed admission 5 tests; HEAD row presentation 1 test; baseline event/admission/effort 9 tests; baseline provider controls 11 tests; baseline binding-revision control 11 tests; baseline browser 3 tests. Counts overlap and are not unique coverage totals. Earlier harness invocations failed due duplicate CLI options, missing fake managed launch, and a missing test-only fs import; corrected runs passed. Their retained logs are identified as retries, not product defects. HEAD full-view panel assertions remain blocked by the hydration failure described above.

Final verification: `bun run fmt docs/qa/regression-repros-0144.md` passed (scoped to the report to avoid formatting other threads' product code); `bun run lint` passed with 521 warnings and zero errors; `bun run typecheck` passed with all 11 Turbo tasks cached. These workspace results do not typecheck the scratch-only probes. Logs are included in the evidence directory. No product fixes were designed or committed.
