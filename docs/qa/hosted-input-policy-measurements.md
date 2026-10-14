# Hosted input while shell views are preserved or detached

Measured 2026-10-14; source `c5adb021dd132ac9595c7a8b84adf9a2cbcc4bf0`, version 0.14.4. Findings only. Extends [visibility investigation](hosted-view-visibility-regression.md) and [tab investigation (f)/(h)](tab-activation-hang.md).

**Preserving attachment alone does not make all agent input immediate with default background throttling.** All nine typing trials under preservation in an off-screen full-screen Space, a minimized window, and native application Hide timed out at 30 seconds without an input event. Disabling throttling on all scratch WebContents made preservation pass all 27 supplemental click/type/scroll trials in those same three states, with a worst effect delay of **317 ms**. This establishes sufficiency in this fixture; it does not isolate the minimum WebContents that need that setting or establish a universal latency bound.

Current detachment passed all Space/minimized trials within one second. Its application-Hide trial **failed the hidden-state precondition**: the shell re-showed before input began. Both policies passed the validated complete-cover case.

## Policies, commands and timing

Policy A applies only the `24110c887` preservation branch to current HEAD's `hideWindow`: keep owner, set native visibility from `visibleRequested && freezeDepth === 0`, preserve page visibility using `#shouldShowPage`, and omit detachment. Policy B uses the unmodified current host. Both scratch observers bypass only `#requireActive` admission/cancellation. There were no `TAB_NOT_ACTIVE` errors. [Source hashes and exact patches](hosted-input-policy-measurements/source-hashes.json) record the differences.

All inputs traverse real `executePenkraExecCommand` → authenticated local `AppCommandPipeServer` → real `AppTabObserver`; these are actual `penkra tabs act` commands, not replacement DOM commands. DOM evaluation only resets/reads the probe and marks its color after trials. Installation/session readiness and the selected-folder/observation resolver are local fixtures. No account, provider or database is involved. The rendered pane is real current `AppDockPane` inside a diagnostic native shell, rather than a complete installed Penkra startup.

Each state has three trials of each action. Event delay is page `Date.now()` at its effect event minus command-issued epoch time, with millisecond resolution. Click's effect is `click`, type's is `input`, and scroll's is `scroll` at 400 px. Scroll position is also read separately. CDP start/end and observer-phase timestamps distinguish preparation, dispatch, page effect and command completion. Hidden Electron `executeJavaScript` diagnostic reads waited in the initial setup; measured runs instead read the probe through CDP and cache renderer visibility-change messages, with direct probe visibility recorded after every command.

[Primary per-trial JSON](hosted-input-policy-measurements/primary-per-trial.json) records all 72 required trials. [All-trial CSV](hosted-input-policy-measurements/per-trial.csv) / [JSON](hosted-input-policy-measurements/per-trial.json) add the 45 supplemental trials. Every row includes response/success/error, event trust, native visibility/minimization, application hidden state, both document visibility states, owner/child count before and after, throttling and exact command/page timestamps. Complete logs and snapshots are gzip-compressed under `runs/`.

## Primary matrix: background throttling on

The three values in each cell are trials 1/2/3, in milliseconds. “None” means no qualifying event during the command plus approximately 1.1 seconds of post-command observation; eventual events are separately recorded. V/M denotes shell BrowserWindow visibility/minimization, not host tab visibility. Owner 1 is the shell renderer. All retained children were native-visible.

| Policy/state                          | Click event ms     | Type input ms      | Scroll event ms    | Command result                                                     | State before trials: V/M; shell/page documents; owner/children |
| ------------------------------------- | ------------------ | ------------------ | ------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------- |
| A / other full-screen Space           | 92 / 43 / 17       | None / None / None | None / None / None | Click/scroll success; each type caller receives 30 s timeout       | true/false; hidden/hidden; 1/2                                 |
| A / minimized                         | **3400** / 32 / 10 | None / None / None | None / None / None | Same                                                               | false/true; hidden/hidden; 1/2                                 |
| A / app.hide()                        | 22 / 24 / 20       | None / None / None | None / None / None | Same; application remains hidden                                   | false/false; hidden/hidden; 1/2                                |
| A / completely covered by another app | 321 / 299 / 303    | 309 / 304 / 301    | 4 / 5 / 4          | All success                                                        | true/false; visible/visible; 1/2                               |
| B / other full-screen Space           | 21 / 5 / 7         | 309 / 303 / 305    | 2 / 6 / 8          | All success                                                        | true/false; hidden/visible; null/0                             |
| B / minimized                         | 37 / 7 / 5         | 316 / 302 / 306    | 7 / 3 / 4          | All success                                                        | false/true; hidden/visible; null/0                             |
| B / app.hide() attempt                | 326 / 309 / 302    | 316 / 294 / 300    | 5 / 5 / 5          | All success **after spontaneous re-show; not hidden-app evidence** | true/false; visible/visible; 1/2; application no longer hidden |
| B / completely covered by another app | 320 / 299 / 308    | 308 / 309 / 302    | 3 / 5 / 6          | All success                                                        | true/false; visible/visible; 1/2                               |

Click events were trusted. Delivered type input events were untrusted, as expected from the existing setter + synthetic `InputEvent` implementation. Delivered natural scroll events were trusted. Absent events have null trust, not false trust. “Caller receives timeout” means a local command-client error returned; no successful desktop command response arrived before the 30,000 ms limit. Socket closure aborts the observer interaction. The harness separately bounds pending calls, inspects state and records any recovery; it does not treat an unknown outcome as successful delivery.

Under A, scroll position reached 400 px promptly: first post-command reads bounded its effect to **3–324 ms** across the nine background trials. Event callbacks did not arrive during their observation intervals. The last scroll in each state emitted on return: Space **1848 ms**, minimized **1890 ms**, Hide **1430 ms** after command issue. Earlier scroll callbacks were not observed; subsequent resets can coalesce them. Thus position mutation and scroll-event delivery are different measured outcomes.

For B Hide, native times were: request 4953 ms; `shell-window-hide` 4999 (V/M false/false); `window-hide-applied` 5100; `shell-window-show` 5142 (true/false). It remained re-shown for all nine trials. The source of re-show was not isolated here; a permanently hidden app cannot be claimed from those rows.

Both full-screen shells were in native full-screen mode; the first was validated on screen before focusing the existing second shell, then absent from the ordered CG on-screen list during input. Complete cover used a separate scratch Cocoa application's opaque floating window, without application activation, with **identical WindowServer rectangle** `{X:70,Y:70,Width:1000,Height:700}` and a smaller front-to-back on-screen ordinal than the shell in every trial. Earlier partial-cover attempts had incorrect AppKit Y conversion and are excluded. No physical swipe/keyboard event was injected.

## Throttling and the old 11.5-second typing delay

The historical repeat in (f) proves that the **cursor movement phase**, not the final value setter/input event, consumed the delay:

- Command sent at 5921 ms; cursor movement began at 5932 ms.
- Twelve `mouseMoved` dispatch requests ran from 5932 through 16445 ms, mostly about one second apart.
- Cursor movement completed at 17454 ms; value-setting `Runtime.callFunctionOn` was sent at 17461 ms; input event occurred at 17462 ms; response returned at 17463 ms (11,541.2 ms total).

[Original sequence](hosted-input-policy-measurements/original-f-typing-sequence.json) retains the precise timestamps. Importantly, that repeat reported **hostVisible true and page document hidden**, and has no completed hide/detach in the interval after the last owner-1 `present-applied`. It is not evidence of a settled detached-host state. This corrects any inference from the state name “hidden” alone in the earlier report. The reason that run did not execute the expected hide transition was not isolated.

Current full start/end tracing localizes the matching slowdown **inside CDP `Input.dispatchMouseEvent` for `mouseMoved`**, before the setter. For example, A/minimized's first type trial's first movement call starts at **10870 ms**, ends at **15976 ms** (5105.8 ms); the next starts at **15993 ms**, ends at **21036 ms** (5042.8 ms); the next starts at **21054 ms**, ends at **26060 ms** (5005.7 ms). Between calls, cursor-overlay CDP reads/evaluations return promptly and the planned 15 ms main-process pauses take about 17–18 ms. The observer is waiting for the dispatch acknowledgment, not waiting 5 seconds in its intended cursor animation timer or waiting for an already-dispatched input event. Type reaches the command limit before its setter is issued.

The first slow A/minimized click also waited in CDP preparation (`Page.enable` ~620 ms and `Page.getFrameTree` ~2158 ms), plus ~409 ms mouse dispatch. [Slow CDP phases](hosted-input-policy-measurements/slow-cdp-phases.json) and complete compressed phase records retain call-level timings.

A supplemental attached regular-window hide, explicitly enabling throttling and taking a snapshot while hidden as in (f), reproduced CDP movement waits/timeouts; it did **not** reproduce the exact historic one-second cadence/11.54-second total. A settled B `shell.hide()` repeat passed all nine actions: type **311 / 307 / 303 ms**. The original logs lack CDP completion timestamps, so its individual dispatch-versus-overlay split cannot be reconstructed directly; the historic movement phase and the current dispatch-wait mechanism are separately established. No claim about Chromium's internal scheduling beyond these measurements is made.

Turning throttling **off on all scratch WebContents** while preserving ownership passed:

| A state                 | Click ms   | Type ms         | Scroll ms  |
| ----------------------- | ---------- | --------------- | ---------- |
| Other full-screen Space | 18 / 9 / 7 | 317 / 310 / 302 | 5 / 10 / 9 |
| Minimized               | 28 / 7 / 7 | 313 / 302 / 313 | 3 / 4 / 7  |
| App hidden              | 16 / 8 / 9 | 314 / 309 / 309 | 9 / 4 / 4  |

Native state remained off screen/minimized/hidden, owner stayed 1, and children stayed 2. Electron reported shell/page documents visible with throttling disabled. The active-presentation guard remained bypassed. This is observed sufficiency, not a proposed product change, an isolated minimum-setting result, or an explanation of every older run where disabling throttling failed to remove latency.

## Return and replica visibility under A

Native ownership and both visible children stayed intact through every sampled return. Default-throttled returns published live presentation within approximately **1 ms of native show/restore**; the first on-screen samples were live with two children. Focus/restore request to native event took ~279 ms for Space, ~647 ms for minimized, and ~197 ms for Hide, including native transition time. These are not host reattachment delays because there was no detachment.

A logical replica can nevertheless exist while the shell is on screen: in the unthrottled Hide return, one on-screen sample at ~22103 ms still reports replica presentation/host-visible false, owner 1, and two native-visible children. The native show event at 22342 ms then publishes live in ~0.3 ms. The renderer replica is beneath the preserved native views; a replica label alone does not establish user-visible replica exposure.

**Painted-frame immediacy and absence of a replica flash remain unverified.** All native window image-capture attempts failed, and `CGPreflightScreenCaptureAccess` is false. Attachment/visibility/bounds and event timing establish structural continuity, not a frame-by-frame optical measurement. No screen-recording/accessibility authorization or OS setting was changed. [Return summary](hosted-input-policy-measurements/return-summary.json) records all samples, show/restore events and capture failures.

## Isolation, evidence and exclusions

Scratch root `/Users/emmanuelgyekyeatta-penkra/Penkra/qa-policy-input-l4s7e3xe`; separate homes per policy/state; explicit ports 3919/5919 and VITE_DEV_SERVER_URL on the Electron process. Local HTTP renderer fixture serves bundled real AppDockPane; no Vite daemon or production server is used. Electron 44.4.1, macOS 26.3. Historical preservation is a scratch-only patch. Release product code and version were untouched. No production DB/app, provider home/account, paid call, signing, installation, push or publish was used.

[Harness/rerun notes](hosted-input-policy-measurements/README.md) explain the experiment and exact source variants. The first unbounded setup is excluded. A Unix socket path-length failure is excluded. Initial minimized runs completed all nine trials and returns, then failed in harness cleanup by calling an absent optional observer disposal method; the cleanup invocation was corrected for later runs. Those completed measurements are retained, with the failures explicit. Actual command-client timeouts are findings, not harness cleanup failures.

All owned processes and fixture servers were stopped. JSON/gzip/source/geometry/ownership checks are recorded in integrity evidence; no product tests were added or product fixes designed.
