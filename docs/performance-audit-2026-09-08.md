# Penkra performance: measured evidence, September 8–9, 2026

This records completed observations, not a second plan or an approved implementation.
Active work and validation boundaries remain in the root `TODO.md`. No product behavior,
animation setting, provider activation, version, or user-owned process was changed by this audit.
Characterization tests and local evidence were added. Concurrent work in this checkout is not
attributed to this audit.

## Interpretation and provenance

- CPU uses **100% = one logical core**. GPU-process CPU is not hardware GPU utilization.
- CPU deltas are cumulative process time divided by elapsed monotonic time. Endpoint samples
  omit processes born and gone between endpoints. RSS is not unique physical memory and cannot
  establish a leak from a single snapshot.
- These are controlled observations on a busy shared machine, not universal benchmarks.
  Do not add independent experimental percentages or call fixture speedups production savings.
- Ten-, twenty-, and thirty-second intervals are measurement windows, **not product gates**.
  Twenty repeated SQL calls sample timing; 512/8,000/32,000 rows are fixture stress points,
  not measured production row counts. The seed 918273 makes differential cases repeatable.
- Installed production observed here was 0.12.2; local dirty source included independent 0.12.3
  work. Electron 40.10.6 used Chromium 144.0.7559.236 and SQLite 3.51.3. The recreated server
  fixture run used system Node 24.19.0 / SQLite 3.53.3, explicitly a different SQLite build.
- Original scratch artifacts disappeared during an active write around 01:13 UTC September 9.
  The cause/actor is unknown. Exact Trash and open-deleted-file checks found no recovery.
  Earlier results below are labeled transcript-only; they are not falsely linked as raw files.
  Fresh evidence is under `.penkra/scratch/performance-20260908/`, with a retention README.

## Production server: repeated journal scans

`production-sql-recheck.json`, 01:22:13 UTC, 30.004 seconds:

| Observation                  |                       Result |
| ---------------------------- | ---------------------------: |
| Backend CPU time             | 4,868.252 ms, or 16.225% CPU |
| All instrumented SQL elapsed |                 4,864.864 ms |
| Pending-journal reader       |      170 calls, 4,308.677 ms |
| Reader share of timed SQL    |                      88.567% |
| Reader mean / maximum call   |          25.345 / 154.821 ms |
| Receipt-tail cleanup         |         28 calls, 206.301 ms |

The observer timed already-issued `all/run/get` operations, without parameters or result rows.
It used only a private in-memory connection for prototype discovery, never a second connection
to live `state.sqlite`. Exact-process guards, an occupied-inspector refusal, a 45-second restoration
watchdog, explicit restoration and inspector close were used. The result records restoration;
the subsequent port check found no listener. SQL elapsed is **not per-query CPU attribution**.
This was an active server observation, not server idle.

`ProviderRuntimeEvents.ts` uses a windowed query partitioned by Thread, joined to each cursor,
excluding deferred/quarantined failures, then applies per-Thread and total limits. Its plan scans
retained history before the final limits. `ProviderRuntimeIngestion` wakes on work rather than
idle polling. This reader is shared across providers, not an OpenCode-only path.

The recreated actual-migration, in-memory fixture (`journal-control.json`) measured:

| Retained rows, no pending rows | Current SQL mean | Known-Thread indexed seek mean |
| ------------------------------ | ---------------: | -----------------------------: |
| 512                            |         0.211 ms |                       0.035 ms |
| 8,000                          |         1.703 ms |                       0.036 ms |
| 32,000                         |         6.518 ms |                       0.027 ms |

One pending row had similar scaling. The SQL is extracted from current source, not a loosely
similar query. Eighty seeded multi-Thread cases matched the actual repository reader across
cursors, fences, limits, active retry deadlines, quarantine and resolved failures. A 480-event
drain advanced actual contiguous repository cursors without duplicates in four fetched batches.
The same retained fixture also admitted a new Thread after the drain, excluded its event below
the old fence, included it at the new fence, advanced its actual cursor and returned empty on a
subsequent stateless read. Its sequence was 32,001 because prior stress setup advanced SQLite's
autoincrement counter; sequence continuity must not be confused with an event count.
The experimental multi-Thread seek still discovers Threads using `SELECT DISTINCT thread_id`;
it is not a complete scalable replacement, process-crash test, or production savings estimate.
Earlier transcript-only evidence also exercised admission of a 481st event/new Thread and a
recreated stateless reader. Its original harness is lost; do not equate that with retained raw proof.

The existing 128 total / 32 per-Thread limits are source policy, not values selected or justified
by this benchmark. A fetched batch is a set of rows, not automatically a transaction. This audit
does not propose changing those constants or mixing storage errors into provider event semantics.

## Rejected send: a stale status creates ongoing animation work

Fresh numbered Dev 2, ordinary `Hi`, Thread `3b496712-9734-429b-9295-e026ba99d6c3`:
Free / Deepseek V4 Flash rejected the send with “The selected anonymous route cannot authorize
this model.” No provider session or turn was created. Native UI and retained diagnostics agree.

`rejected-lifecycle-diagnostics.json` separates ownership:

1. Local send owns the pending request and adds one optimistic user message.
2. The server Thread appears; local draft identity is marked promoted.
3. Detail hydration becomes `synced`, with **zero projected messages**, no session and no turn.
4. Local send ownership clears and the chat's Thinking row disappears.
5. Sidebar still derives Working from the promoted-draft marker alone.

This is not evidence of a missed detail notification: detail is synced but empty. Root promotion
reconciliation finalizes only when a session/turn or canonical detail message exists. The retained
optimistic message does not satisfy that predicate. The actual sidebar derivation control returns
Working with the marker and no status with the marker removed. Preserving failed-send content and
clearing execution-status ownership are distinct concerns; no cleanup fix was shipped here.

### Actual Thread A/B/A

`rejected-foreground-profile.json` used explicit foreground emulation to hold rendering activity
constant despite desktop occlusion. This is **not normal hidden-window idle**. Temporary React
commit/mutation probes and spinner pauses were restored and the emulation disabled afterward.

| Ten-second phase   |   Renderer + GPU CPU | React commits | DOM mutations |
| ------------------ | -------------------: | ------------: | ------------: |
| Running            |               28.19% |             1 |             3 |
| Temporarily paused | 0% at `ps` precision |             0 |             0 |
| Restored           |               28.50% |             0 |             0 |

All phases had zero layouts. Restored phase had 84 style recalculations and 0.0016 seconds of
page JavaScript. A React rerender loop is not necessary for this reproduced cost.

### Shell visual composition, with all application scripts removed

`dom-material-control.json` rendered a captured Dev DOM/CSS in the same Electron version,
1261×780 viewport, DPR 2, with scripts blocked, no React or provider connection. Its screenshot
was visually inspected. Explicit foreground emulation was again used.

- Full DOM with native vibrancy: 27.56% renderer/GPU CPU.
- Native vibrancy disabled as a diagnostic control: 28.94%.
- Vibrancy restored: 28.55%.
- Isolated copied spinner in the same-sized vibrant window: 9.37%.

All had zero style recalculations, layout and measured page JS during observation. Thus the
full static shell amplifies compositor work relative to a small widget, independently of React.
Native vibrancy alone did not explain the difference. This is not a claim that all Electron
pages must cost this much or that all compositor mechanisms have been isolated.

Further controls in `dom-effects-control.json`:
full-shell baseline 22.55%, transcript mask removed 22.07%, restored 23.86%, all backdrop filters
removed 24.26%, restored 27.45%, spinner paused 0%, restored 27.05%.
Changing backdrop/mask effects did not establish a repeatable isolated gain beyond baseline drift.
The scroll-timeline fade remained present in the zero-CPU paused-spinner phase. No such visual
effect was removed from Penkra. Earlier actual-sidebar mask/backdrop controls likewise failed to
establish a gain (`sidebar-compositing-control.json`).

### Finished entrance-animation state: additional controlled rejection

The 02:03 UTC Dev layer snapshot (`layer-tree-control.json`) shows the spinner already in its own
26×26 physical-pixel layer with accelerated transform-animation and will-change reasons. It also
shows larger layers associated with the finished sidebar and message entrance animations. This
layer inventory is not a measurement of how much CPU each layer consumes. The initial naturally
hidden observation returned no layer inventory; temporary foreground emulation produced the
recorded inventory and was explicitly disabled afterward.

`dom-settled-animation-control.json` tested the actual two finished entrance animations in the
isolated full-DOM copy: commit their terminal styles, cancel them, and clear their animation-name
and will-change hint. The continuously running spinner and scroll-timeline fade remained. Reload
restored the original captured document between controls. Renderer/GPU CPU in five ten-second
windows was baseline25.14%, cleanup26.84%, restored26.85%, cleanup26.36%, restored26.55%.
All windows had zero style recalculations, layouts and measured page JavaScript. No repeatable
gain was established. Baseline/restored PNGs matched exactly; both cleanup PNGs matched each other
but differed from baseline in 133 of 3,934,320 pixels, inside the user-message text region
(`settled-pixel-comparison.json`). This control is not an exact-image-equivalent replacement.
The owned standalone Electron processes exited. No Penkra source/style setting was changed.

`audit-source-identity.json` records ten relevant current-worktree source hashes and Git HEAD at
02:05 UTC. Those hashes identify this inspection's source state, not every earlier running build.

### Earlier widget/shimmer experiments — transcript-only after evidence loss

Matched Electron widget-only, without React: spinner about 9.2–9.5%, shimmer 23.4–23.8%, both
24.1–25.7%. Shimmer produced about 1,200 style recalculations per ten seconds without layout or
page JS. Visually identical `will-change`, transform promotion and containment controls did not
reduce that work; final baseline repeat was interrupted by evidence loss. This is not an exhaustive
rejection of animation techniques or approval to disable shimmer.

Playwright's automatic focus emulation invalidated an initial hidden-window interpretation.
A debugger-free matched Electron control subsequently measured hidden widgets at 0.017%
renderer/GPU CPU, with native window invisible and document hidden. Re-shown occlusion was
confounded and was not treated as a valid visible replicate. The original raw artifacts are lost.

## Browser and App observations

Native Dev 2 opened Browser through Apps and loaded `https://example.com`. The sidebar was
hidden to exclude its stale spinner. The visible screenshot was inspected.

- Visible static page, 30.163 seconds: whole Dev process group about 1.23% CPU (transcript result).
- Browser retained while Apps catalog selected, 30.166 seconds: about 0.10%
  (`browser-retained-hidden.json`).
- Closing Browser removed its UI renderer and hosted-page renderer. Its per-App Node controller
  and Dark Reader extension background remained, at zero CPU at sample precision
  (`browser-closed.json`, subsequent CDP target inspection). This retention alone is not a heat
  explanation or proof of a memory leak. The differently timed close sample is not a clean gain A/B.

The simple-page controls do not reproduce a blanket Browser tax. They do not establish resource
cost for every website, active automation, screenshot capture or long-lived provider workload.
No user's production tab or provider was closed. The audit's Browser/Apps tabs were closed.

### Two observability/lifecycle defects, separate from measured CPU

`browserManager.ts` records `webContents.getProcessId()` but the performance logger joins that
to `app.getAppMetrics().pid`. A real Electron control produced internal ID 4, OS PID 95363:
the current join returned no process, while the OS-PID join found the Tab. `process-id-control.json`
retains versions/results. An empty Browser process list therefore cannot prove zero usage.
[Electron documents the two distinct identifiers](https://www.electronjs.org/docs/latest/api/web-contents).

The old snapshot event-listener accumulation is covered by current disposal code and existing
repeated-navigation tests. Separately, `appTabObserver.audit.test.ts` exercised 100 synthetic
out-of-process frame target changes through the actual observer. After detach notifications and
tab invalidation, snapshot state was zero but protocol-session cache count was 100
(`observer-churn.json`). This establishes a retained target/session-ID map in that path, **not**
retained page heaps, sustained CPU, or a measured material memory impact in production.

## OpenCode: startup, polling and title retention are different questions

Isolated activated OpenCode 1.18.29 used private XDG directories, the actual managed child-env
builder, `serve --pure`, no credentials, no plugins, no model prompt and no Penkra database.
Its logs also show attempts to discover the normal home `.opencode/opencode.json` and `.jsonc`;
exact existence checks found neither file. Private XDG state does not imply the executable never
looks outside that directory. The empty working directory is nested inside this Git repository,
not a separate non-repository control.
The harness creates an empty session and observes documented local status/SSE endpoints.
[OpenCode server API](https://opencode.ai/docs/server/).

`opencode-idle.json` first cold run: 2.70% server-only, then 22.95% in the first empty-session/SSE
window, then 5.09% with polling. The high initial window cannot be labeled persistent idle heat.
`opencode-idle-warm-repeat.json` reuses the isolated fixture cache/data and extends observation:

| Twenty-second phase      |   CPU |     End RSS |
| ------------------------ | ----: | ----------: |
| Server only              | 1.80% | 369,792 KiB |
| Empty session + SSE      | 1.25% | 374,240 KiB |
| Status poll every 500 ms | 4.35% | 375,200 KiB |
| Later quiet SSE          | 0.95% | 289,104 KiB |
| Later status polling     | 3.91% | 289,808 KiB |
| SSE closed               | 0.65% | 289,744 KiB |

Polling phases made 40 requests each. The three-second native sample overlaps the initial SSE
phase and adds observer overhead; the main thread was waiting in `kevent64` in 259/260 samples.
The owned server exited after the experiment. Startup process CPU was 1.38 seconds. No title or
LLM generation was needed for the cold transient; no persistently hot idle runtime was reproduced.

Penkra's OpenCode watchdog runs while its context owns an active turn, sleeping 500 ms between
status requests. Plain OpenCode fetches full messages only once the status is not busy; other
OpenCode-family configurations can additionally request busy transcript catch-up. Normal
settlement ends the loop. A stuck active-turn context could keep polling, but that is a hypothesis
unless the corresponding runtime state is observed; an empty-session benchmark does not prove it.

Title generation is forked from turn start, not synchronously awaited as a gate before the main
turn. Completed shared-server requests decrement ownership and schedule the existing 30-second
idle close. `OpenCodeTextGeneration.audit.test.ts` replaces only transport/process with a stalled
promise: advancing one hour of simulated time leaves the server owned; explicitly interrupting
the request then permits close after 30,001 simulated milliseconds. No cancellation signal is
passed to the mocked SDK prompt call. This proves missing service deadline behavior, not that a
real stalled title is CPU-hot. Codex title generation uses an ephemeral command and a 180-second
timeout in its separate implementation; it does not share this exact transport path.

## Whole-process attribution and verification

The 01:17 production tree also contained an agent-launched headless Android emulator at 156.07%
CPU, its network helper at 28.31%, and two test workers at 61.09% / 60.50%. Parent chains reached
an active Codex agent. These are real agent tool workloads, not proved host-framework defects;
none was stopped. Production backend was 13.06%, shell 0.63%, main 0.07% in that window.
The only OpenCode found in those endpoints belonged to Zed, not Penkra. Computer Use service
and WindowServer activity are measurement/shared-desktop confounders, not all chargeable to Penkra.

The later `final-host-sample.json`, 01:56:32.948–01:57:03.090 UTC, measured the production main
process and its direct host children at **52.22% CPU**: backend 23.72%, GPU process 14.56%, shell
renderer 13.50%, main 0.36%, network 0.07%. Three managed Codex runtime endpoints were about
6.07%, 0.365% and 0.033%; tool subprocesses are separate. No Penkra-managed OpenCode was present.
Dev 2 was occluded and about 0.10% CPU. These are different active/visibility conditions, not an
apples-to-apples production-versus-Dev comparison or proof of a release regression. Production
main/backend/shell RSS were 281,168 / 308,784 / 331,792 KiB. Summed direct-host RSS was 2,840 MiB,
including retained renderers/shared memory; it is not unique physical RAM or a leak diagnosis.

Focused existing tests passed: runtime repository 6; ingestion/buffer/session reaper 119;
OpenCode title/runtime/adapter 92; App observer/browser/session policy/host 61; selected ChatView
browser cases 4 (114 skipped). Added characterization tests cover stalled title ownership,
journal access-path equivalence and protocol-session map retention. Tests do not replace the
blocked successful-provider native path. Fresh Dev 2 was manually exercised for rejected send,
sidebar state, Browser navigation/retention/close and Apps close. Successful provider-turn and
post-completion idle QA could not run with its offered anonymous route. No credentials were copied.

Reproduction commands for characterization tests (repository-relative):

```sh
cd apps/server
bun run test src/persistence/Layers/ProviderRuntimeEvents.audit.test.ts src/textGeneration/Layers/OpenCodeTextGeneration.audit.test.ts
cd ../desktop
bun run test src/appTabObserver.audit.test.ts
```

Local raw-CDP harnesses refuse unless the exact audit Dev Thread is present. They are forensic
artifacts with recorded process/window assumptions, not general-purpose production tooling.
No formatter, linter or typecheck was run without the repository-required explicit request.
The registered dispatcher has no `penkra todo create` operation (confirmed by its generated help);
the validation blocker is therefore recorded in the repository's canonical `TODO.md`, not reported
as a successfully created Penkra Todo.

At 02:07:46 UTC, a fresh inspection of the exact Dev 2 QA Thread's connection/model menus still
offered only Free and Deepseek V4 Flash (`dev-provider-blocker-recheck.json`). This verifies the
configuration boundary rather than merely relying on the old error banner. No model, connection,
credential or message was changed. Menus were closed afterward. No audit harness process remained
running; continued successful-provider validation requires an operator-provided working Dev route.
