# Penkra CPU and performance audit — 2026-08-28

## Executive conclusion

There is no single system-wide cause. The audit found three independent high-CPU classes:

1. **A retained Penkra Browser renderer was the original sustained one-core consumer.** PID 63073 held 98–100% CPU for more than 20 minutes and reached about 1.2 GiB physical footprint. A 6-second native sample found its main thread continuously executing V8/JIT JavaScript, with no idle wait. Restarting Penkra terminated it and it did not return. The exact hosted URL could not be resolved safely from the current thread, so attributing it to a particular site or extension would be speculation.
2. **After restart, the Penkra shell itself became the largest transient consumer while very large audit results were entering the transcript.** PID 25332 held 101–139% CPU across five one-second observations (mean 115.7%) and about 654–659 MiB RSS. Its native sample also showed a continuously active V8 main-thread call chain. A dev Penkra shell showed a similar pattern at 27–85% (mean 60.2%). After the large results settled, PID 25332 fell to 0.1% and PID 14578 to 0.0%; all seven installed Penkra renderers aggregated to 0.1% CPU. This establishes a shared shell/renderer JavaScript hot path under transcript load, not a second permanent loop. Stripped/JIT frames prevent naming the exact JavaScript function from the native samples alone.
3. **Docker's VM, WindowServer, and the computer-use capture service add large separate costs.** Docker's VM ranged from 4.6% to 193% during a five-second window and later reached 248%, while the highest individual container snapshot was only 3.09%. WindowServer ranged from 45.7% to 75.2%. The computer-use service ranged from 17.2% to 31.0%, so part of the observed load is audit instrumentation overhead.

The machine was not thermally constrained. Memory was heavily occupied and compressed, but macOS reported roughly 55% memory-pressure headroom and no current swap activity during the initial capture.

## Evidence timeline

| Time (America/Denver) | Evidence | Interpretation |
|---|---|---|
| Before 10:46 | Load average approximately 17.85 / 18.95 / 17.50, later peaking around 37–40 | Severe accumulated runnable work, not a single-process metric |
| Before restart | Installed Penkra renderer PID 63073 at 98–100% for >20 minutes, 0.9–1.2 GiB | Original sustained one-core burner |
| Before restart | `sample 63073 6` captured 2,235 active main-thread samples in V8/JIT | CPU was JavaScript execution, not an idle renderer or native I/O wait |
| 10:46:55 | Penkra restarted; PID 63073 disappeared | Natural A/B intervention cleared the original hot renderer |
| 10:47 | New Browser renderers 25966/25967/25970 were idle | The old Browser workload was not automatically recreated immediately |
| 10:49–10:50 | Main shell PID 25332 rose to 101–139%; dev shell PID 14578 rose to 27–85% | A second renderer-side workload appeared in shared shell code |
| 10:50:13–17 | Docker VM 4.6–193%, WindowServer 45.7–75.2%, computer-use 17.2–31.0% | Independent burst and display/capture overhead remained |
| 10:53:31–54 | Installed shell 0.1%, dev shell 0.0%; all seven installed renderers 0.1% aggregate | Transcript/audit-load spike settled; it was transient rather than a retained loop |

Native sample files produced during the audit are `/tmp/penkra-renderer-63073.sample.txt`, `/tmp/penkra-renderer-25332.sample.txt`, and `/tmp/penkra-dev-renderer-14578.sample.txt`. They are temporary evidence, not durable product logs.

## What was eating CPU most

### Original state

The largest stable consumer was Penkra's hosted Browser renderer PID 63073 at essentially one full core. WindowServer was generally second at 40–60%, and Docker's VM was bursty, occasionally exceeding a core. The other Penkra shell renderer was lower and variable.

The Browser renderer launched at 10:16:31 with three sibling renderer processes. A Dark Reader extension warning occurred at the same second. That is useful correlation, but it does **not** prove Dark Reader caused the loop. The hosted page, page plus extension interaction, a worker, or a retained lifecycle bug all remain possible.

### Post-restart state

Across the five-sample controlled observation:

| Process | CPU range | Mean | RSS range / observation |
|---|---:|---:|---:|
| Installed Penkra shell renderer PID 25332 | 101.3–139.0% | 115.7% | 654–659 MiB |
| Penkra dev renderer PID 14578 | 26.8–84.9% | 60.2% | 726–739 MiB |
| WindowServer | 45.7–75.2% | 61.6% | about 233–239 MiB |
| Docker virtualization VM | 4.6–192.9% | 49.9% | about 2.65 GiB RSS |
| Computer-use capture service | 17.2–31.0% | 25.8% | about 100 MiB |
| `ecosystemd` | 6.7–43.4% | 25.0% | about 19–25 MiB |

CPU percentages above 100% mean more than one logical core on macOS.

At the final quiet-state point measurement, Docker's VM briefly led at 84.1%, WindowServer was 43.0%, `ecosystemd` 35.6%, and computer-use 18.5%. A seconds-later point sample showed the burstiness directly: VM 7.1%, `ecosystemd` 2.8%, WindowServer 40.1%, and computer-use 21.0%. Penkra itself was then effectively idle.

## Process attribution

Electron uses a Chromium-style multi-process model: the main process manages the application, while windows and web embeds execute in renderer processes. Electron explicitly documents that web embeds receive renderers too. This is why PID-level attribution matters rather than treating every `Penkra Helper (Renderer)` as the same UI. See [Electron's process model](https://www.electronjs.org/docs/latest/tutorial/process-model).

Source confirms that Runtime v2 visual Apps are DOM iframes inside the trusted shell, not hidden native renderers (`penkra/apps/desktop/src/electronAppTabHost.ts:501-504`). Therefore:

- PID 63073 was a hosted Browser page renderer, not the Canvas visual App.
- PID 25332 is the main installed Penkra shell renderer.
- PID 14578 is the main renderer for a local Penkra dev instance.

## Code findings

### P0 — Missing always-on renderer ownership and CPU telemetry

Penkra already has a five-second `app.getAppMetrics()` sampler, but it only runs when `PENKRA_BROWSER_PERF=1` (`penkra/apps/desktop/src/main.ts:446-453, 1362-1385`). It was not enabled in the installed production process. Consequently, the production logs could not answer the most important question: which retained page/tab owned OS PID 63073 and what its CPU/RSS history was before the incident.

Electron provides the missing primitives directly:

- [`app.getAppMetrics()`](https://www.electronjs.org/docs/latest/api/app#appgetappmetrics) returns CPU and memory metrics for all app processes.
- [`webContents.getOSProcessId()`](https://www.electronjs.org/docs/latest/api/web-contents#contentsgetosprocessid) maps a `WebContents` to its operating-system renderer PID.
- [`process.getCPUUsage()`](https://www.electronjs.org/docs/latest/api/process) and the CPU usage structure expose interval CPU and idle wakeups.

**Fix:** keep a bounded, low-frequency production ring buffer mapping OS PID → webContents ID/type → owning thread/tab/App/page ID, lifecycle state, CPU, RSS, and idle wakeups. Redact URLs to an origin or hash unless explicit diagnostics export is requested. Persist only threshold crossings and lifecycle transitions.

### P1 — Canvas time shaders create an uncapped perpetual repaint loop

`penkra-apps/canvas/src/openpencil-surface.mjs:55-83` contains a real CPU-risk path introduced by commit `8a4e4d22` on 2026-08-25:

- Every animation frame spreads and scans all graph nodes to rediscover whether any time shader exists.
- If one exists, it calls `editor.requestRepaint()` and schedules another animation frame indefinitely.
- There is no App lifecycle visibility check, no hidden-document pause in this loop, no FPS cap, and no reduced-motion/adaptive policy.
- Canvas only cancels the frame during disposal at line 259.

The shell sends Apps `lifecycle.visibility` events (`penkra/apps/desktop/src/electronAppTabHost.ts:292-300, 394`), but Canvas does not subscribe to the SDK visibility hook. Chrome recommends stopping UI updates and unnecessary tasks when a page is hidden; see [Chrome's Page Lifecycle guidance](https://developer.chrome.com/docs/web-platform/page-lifecycle-api). Electron similarly recommends pausing expensive work when its Page Visibility state is hidden; see [BrowserWindow page visibility](https://www.electronjs.org/docs/latest/api/browser-window#page-visibility).

This path is **confirmed defective code**, but it is **not the attribution for PID 63073**, because Canvas is an iframe in the main shell. The active document scan timed out, so whether the currently opened Canvas document actually contains a time shader remains unverified.

**Fix:** cache time-shader presence on document/fill mutations; pause and cancel on App/document invisibility; resume once visible; cap or adapt frame rate; avoid repainting unrelated overlay surfaces; add a fake-rAF lifecycle test proving no frames execute while inactive or after disposal.

### P1 — `AppTabObserver` accumulates navigation listeners

`penkra/apps/desktop/src/appTabObserver.ts:768-785` creates new `destroyed` and `did-start-navigation` closures whenever observation state is recreated. `invalidate()` removes map state but no matching `off`/disposer exists. Production logging recorded:

`MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 destroyed listeners added to [WebContents].`

This is a concrete listener lifecycle defect. It can multiply invalidation work and retain closures, although the sample does not establish it as the one-core loop.

**Fix:** store listener disposers with each observation state and invoke them before target replacement/invalidation; make attachment idempotent per webContents/embedded target; test repeated snapshot→navigation→snapshot cycles and assert listener counts remain constant.

### P1 — Shared shell renderer has a current JavaScript hot path with inadequate production diagnostics

Both installed and dev shell renderers showed continuously active V8 main-thread samples. The transcript virtual list contains deliberate correction/convergence clocks, including 16 ms timer scheduling and a 240-iteration safety valve (`penkra/apps/web/src/components/chat/TranscriptVirtualList.tsx:430-525`). It also performs synchronous measurement integration and `flushSync` around dynamic rows (`:210-245`). These are plausible amplifiers when transcripts contain large, streaming, or repeatedly resizing tool outputs.

However, the evidence does not identify that component as the exact sampled JIT function. Native Electron symbols are stripped/mis-symbolized, and production transcript/performance diagnostics are compiled out behind `import.meta.env.DEV` (`chatScrollDiagnostics.ts:93`, `chatPerformanceDiagnostics.tsx:50,248`). The audit itself produced unusually large tool results, including embedded base64 icon data, so measurement workload likely amplified the shell cost.

**Fix:** add a privacy-safe production performance ring buffer for long tasks, animation-frame lag, React commit duration, transcript row measurement count, correction iteration count/reason, rendered row count, tool-result character/DOM-node size, and virtualization settle time. Add a user-triggered diagnostics export. Cap or summarize large data URLs before they enter/render in the transcript.

### P2 — Hosted Browser lifecycle policy needs explicit verification and enforcement

The main `BrowserWindow` explicitly sets `backgroundThrottling: true` (`main.ts:6881`). Hosted Browser `WebContentsView` creation does not set it explicitly (`browserManager.ts:1758-1766`), so it relies on Electron's default. Electron documents that background throttling controls animations/timers and Page Visibility, and that disabling it on one hosted `WebContents` can affect all WebContents in the host window: [Electron webContents background throttling](https://www.electronjs.org/docs/latest/api/web-contents#contentssetbackgroundthrottlingallowed).

**Fix:** assert and log `getBackgroundThrottling()` for every hosted page; record attach/detach, bounds, visibility, audio/WebRTC, extension set, and freeze/resume state. For inactive retained pages, explicitly detach/zero bounds, enable throttling, and, after compatibility testing, freeze or suspend pages that do not require background execution.

### P2 — Docker VM bursts are not explained by current container CPU snapshots

The VM reached 193–248% while the highest container snapshot was 3.09%; most containers were at or near zero. This means a one-shot `docker stats` view is insufficient. Possible contributors include short guest bursts between samples, Docker engine/filesystem/network work, or VM overhead not assigned to a container metric.

**Fix:** collect 1-second Docker/container, VM, disk-I/O, and network samples for 5–10 minutes; correlate VM spikes with container restarts, builds, file sharing, and database checkpoints. Stop or resource-cap unused local stacks only after the operator selects them.

### P2 — Window/compositor and observability tools materially affect measurements

WindowServer remained around 46–75% after the original Browser renderer was gone. Multiple Electron/dev windows, WebGL/canvas surfaces, screen capture, and frequent transcript repainting can all increase compositor work. The computer-use capture service itself consumed 17–31% during the audit. These must be labeled as observer overhead in future comparisons.

## Logs and failure signals

- Confirmed listener warning at 16:02:24 as described above.
- No contemporaneous renderer crash, OOM, or unresponsive event was found in the inspected current logs.
- A historical repeating TLS `EPROTO` sequence existed on 2026-08-27 but was not current and should not be assigned to today's CPU event.
- Browser process-performance logging was disabled, preventing exact retrospective page ownership.
- Renderer console and transcript performance detail are not reliably persisted in production.

## Controlled reproduction and cleanup

A temporary localhost fixture was created to run an 8 ms-per-frame `requestAnimationFrame` workload and expose frame count, work time, focus, and visibility. It was opened in a Browser page. The bounded page evaluation was interrupted when Penkra stopped/restarted, so the lifecycle comparison produced no valid result and was not repeated blindly.

After restart, the state was re-verified:

- The fixture HTTP server was stopped (`curl` returned connection refused).
- Browser had restored the localhost page in an error state.
- The exact restored fixture pages were closed, leaving a suspended `about:blank` page.
- The temporary fixture file and empty scratch directory were removed.

Therefore there is no successful controlled proof yet of whether detached hosted pages pause rAF in this build. The restart A/B is valid evidence that terminating retained renderer state clears the original one-core burn; it is not a page-lifecycle reproduction.

## Prioritized remediation plan

### First 24 hours

1. Ship bounded always-on PID ownership plus CPU/RSS threshold telemetry.
2. Add a diagnostic action that exports the last 10–15 minutes of process/lifecycle/long-task data.
3. Fix `AppTabObserver` listener disposal and add listener-count regression tests.
4. Pause Canvas shader animation when inactive/hidden and cache shader presence.
5. Add a guarded “reload hot page” recovery path for a hosted renderer sustained above one core or a chosen RSS threshold; require user confirmation if page state may be lost.

### Next iteration

1. Instrument transcript rendering, correction cycles, resize events, React commits, and oversized tool-result payloads in a bounded production buffer.
2. Run a Browser lifecycle matrix: visible, background tab, detached view, minimized window, occluded window, audio/WebRTC active, extension enabled/disabled.
3. Run Canvas perf tests with 0, 1, 10, and 100 time-shader nodes; active and inactive; 60/120 Hz displays.
4. Add sustained Docker VM/container/I/O correlation rather than one-shot stats.

## Acceptance checks

- Every sustained renderer spike can be mapped to an owning page/tab/App without inspecting private page storage.
- An inactive Canvas with a time shader executes zero animation frames and performs zero graph scans.
- Repeated tab snapshot/navigation cycles do not increase listener counts or emit `MaxListenersExceededWarning`.
- A hidden/detached Browser page demonstrates the intended timer/rAF behavior in an automated lifecycle test.
- Opening a transcript with large tool results settles within a fixed frame/time budget and does not sustain >20% of one core after settling.
- Diagnostic collection adds less than 1% average CPU when no threshold is crossed.

## Confidence boundaries

**Confirmed:** PID/process usage, sustained V8 main-thread execution, restart clearing PID 63073, current shell hot paths, Docker VM bursts, low container snapshot CPU, listener accumulation code/warning, Canvas perpetual shader loop, disabled production perf flag.

**Strong inference:** original incident belonged to retained hosted Browser execution; current production and dev spikes share shell-side JavaScript behavior; audit rendering/capture overhead amplified the current measurements.

**Unverified:** the exact hosted URL or JavaScript function behind PID 63073; whether Dark Reader was causal; whether the active Canvas document contains a time shader; the exact JIT function behind PID 25332/14578; whether detached hosted pages are reliably frozen in this build.
