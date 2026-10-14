# Browser tab activation hang reproduction

Report only, 2026-10-14. Source: **b2b81bd032ac7ac9becac760dc7a7d12da11f1e3**, version 0.14.4. No product changes or fixes designed.

## Result

The 30,000 ms hang is reproduced in two conditions: a native-hidden tab remains selected in an **open** renderer dock, and the window becomes hidden/minimized **after activation is claimed but before native presentation**. A collapsed dock reopens successfully. A window that is already hidden fails promptly, as expected.

All commands were exactly `penkra tabs activate --tab-id qa-browser-A`, executed through the real `executePenkraExecCommand` parser/client and authenticated `AppCommandPipeServer`, with caller scope `spaceId=qa-space`, `folderId=qa-folder`, `threadId=qa-agent-thread`, `callerTurnId=qa-turn`. The real `ThreadHomeWindow` maps that caller thread to the shell displaying the tab's folder. Both retained tabs use app ID `com.penkra.browser`.

| Requested case                        | Starting state / intervention                                                                                                          | Exact outcome                                                    |                                        Duration |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------: |
| (a), collapsed dock                   | A already selected; dock closed; A not native-visible                                                                                  | `{tabId:"qa-browser-A",state:"active",readyForInteraction:true}` |                                   **31.181 ms** |
| (a), hidden by another path           | A selected; dock open; `AppTabViewHost.hideInWindow(A)` completed; native owner null / visible false                                   | Command-limit error below                                        |                               **30,002.189 ms** |
| (b), window hides after claim         | B selected; gate presentation after the shell present IPC; call native `BrowserWindow.hide()`, release gate after the window is hidden | Command-limit error                                              |                               **30,002.805 ms** |
| (b), window minimizes after claim     | Same presentation gate; call native `BrowserWindow.minimize()` and release when minimized                                              | Command-limit error                                              |                               **30,003.246 ms** |
| (b), native app hide after claim      | Same gate; invoke `app.hide()` (the native hide operation underlying Cmd-H), release with shell hidden                                 | Command-limit error                                              |                               **30,031.713 ms** |
| (b), neighboring before-claim control | Hold the renderer claim; hide the window, verify hidden, then release claim                                                            | `TAB_ACTIVATION_CANCELLED`                                       | **162.967 ms**, includes intentional gate delay |
| (c), visible-window baseline          | B selected and native-visible; A is a different retained tab                                                                           | `{tabId:"qa-browser-A",state:"active",readyForInteraction:true}` |                                  **161.162 ms** |
| (d), already hidden                   | Hide shell before command                                                                                                              | `TAB_FOLDER_NOT_AVAILABLE`, `dispatched:false`                   |                                   **11.184 ms** |
| (d), guarded repeat                   | Verify the shell remains hidden for 500 ms before command                                                                              | Same `TAB_FOLDER_NOT_AVAILABLE`, `dispatched:false`              |                                    **3.465 ms** |

Durations are single observed monotonic measurements, not latency percentiles. The actual client timeout was left at 30,000 ms; no shortened timer or fake clock was used.

The timeout's exact caller-visible message, with no structured `code` property, was:

```text
App command tabs.activate exceeded its 30000-millisecond limit. Inspect the current state before retrying; a timeout leaves the outcome unknown and must not trigger a blind retry.
```

The stable-hidden caller-visible error was:

```text
TAB_FOLDER_NOT_AVAILABLE: Folder "QA folder" is not open in any window.
Folder "QA folder" is not open in any window.
```

The before-claim caller-visible error was:

```text
TAB_ACTIVATION_CANCELLED: The chosen window can no longer show the App tab.
The chosen window can no longer show the App tab.
```

## Isolation and fidelity

Used a standalone **scratch Electron diagnostic harness**, not Production or an installed numbered Penkra Dev app. Scratch root: `/Users/emmanuelgyekyeatta-penkra/Penkra/qa-tab-activation-a9gf__bo`; Electron profile/session data: its `qa-home`; localhost backend fixture port **3909**, Vite port **5909**. `PENKRA_HOME`, explicit port, `VITE_DEV_SERVER_URL`, and `VITE_WS_URL` were set. Port 3899 was occupied and left untouched.

The harness imports the real `AppTabActivation`, routing/home/focus classes, `AppTabViewHost`, command parser/client/server, and folder-tab HTTP client. It runs real native `BrowserWindow`/`WebContentsView` objects and the unchanged renderer `SingleChatSurface`, `RightDock`, `AppDockPane`, and right-dock store. The activation function, claim/failure/present/hide IPC handlers, diagnostic functions, and hide/show/minimize/restore window handlers were copied verbatim from the archived `main.ts`; [source-fragments.json](tab-activation-hang/harness/source-fragments.json) records the exact text and SHA-256 hashes.

Account services, persisted folder/thread records, unrelated ChatView content, App installation/session services, and App RPC readiness were fixtures. The Browser App document was a local placeholder under its real scoped App origin/partition; this did not load the installed Browser toolbar or a remote page. The caller Thread identity was synthetic, not a paid provider turn. The backend validated the folder-tab DTO through the real HTTP client; it used no SQLite database. No provider account or model call was needed.

For (b), a diagnostic-only gate delays presentation between `shell-present-ipc` and `AppTabViewHost.presentInWindow`. The before-claim control delays the claim method and then calls its original implementation. Neither gate changes the activation decision or its timeout. The physical Cmd-H key event was not sent; the native app-hide operation was executed. These are controlled reproductions of the matching mechanism, not proof of the exact trigger in the reported Production occurrence.

No Production database or `/Applications/Penkra.app` access; no install, sign, push, publish, or product-code edit. Only QA documentation/evidence is committed.

## Observations and correlated logs

Complete per-case logs retain both `[app-tab-diagnostic]` and `[app-tab-host]` events, plus separately labeled `[qa-control]` timing/scope/gate records. Renderer diagnostics include document visibility and focus. Events below are examples from those complete logs; sequence numbers are local to each run and each log category.

| Case                         | Diagnostic events                                                                                                                                                   | Native host events                                                                                                                                   | Evidence                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a), collapsed               | `renderer-pane-mounted` 27 → `renderer-present-requested` 28 → `shell-present-ipc` 29; later `renderer-presentation-received` is live                               | `present-started` 46 → `present-applied` 47, visible window, not minimized                                                                           | [case log](tab-activation-hang/run1/a-collapsed-active-events.jsonl)                                                                                            |
| (a), native-hidden/open dock | Before command: `renderer-presentation-received` 42 reports hidden. After command: no new `renderer-present-requested` or `shell-present-ipc`; only a later blur 43 | `hide-requested` 61 → capture → `low-level-hide-completed` 65 → `hide-applied` 66 before command; no new `present-started` during the wait           | [case log](tab-activation-hang/run1/a-hidden-native-active-events.jsonl), [blank selected dock screenshot](tab-activation-hang/run1/a-hidden-native-active.png) |
| (b), hide after claim        | `shell-present-ipc` 58; document becomes hidden; `shell-window-hide` 62 reports `isVisible:false`; presentation received as replica                                 | `present-started` 81 → `present-applied` 82 with `windowVisible:false`; visibility handling records hidden; no successful activation acknowledgement | [case log](tab-activation-hang/run1/b-hide-after-claim-events.jsonl)                                                                                            |
| (b), minimize after claim    | `shell-present-ipc` 84; `shell-window-minimize` 88 and `shell-window-hide` 90 report `isVisible:false,isMinimized:true`; presentation received as replica           | `window-visibility-completed` 122/126; then `present-applied` 128 with `windowVisible:false,windowMinimized:true`                                    | [case log](tab-activation-hang/run1/b-minimize-after-claim-events.jsonl)                                                                                        |
| (b), native app hide         | `shell-present-ipc` 21; `shell-window-hide` 24 reports hidden; presentation received as hidden                                                                      | `window-visibility-completed` 35; `present-applied` 37 records `windowVisible:false`                                                                 | [case log](tab-activation-hang/run2/b-cmdh-after-claim-events.jsonl)                                                                                            |
| (b), before claim            | Renderer visibility/blur 17/18; `shell-window-hide` 21. QA claim result is **false** while the window is hidden. No activation present IPC                          | Visibility/capture/hide events 27–32; no native activation presentation after command                                                                | [case log](tab-activation-hang/run3/b-hide-before-claim-events.jsonl)                                                                                           |
| (c), baseline                | `renderer-present-requested` 20 → `shell-present-ipc` 21; presentation received live                                                                                | `present-started` 29 → `present-applied` 30 with a visible, non-minimized window                                                                     | [case log](tab-activation-hang/run1/c-visible-other-events.jsonl)                                                                                               |
| (d), stable hidden           | Before command: `shell-window-hide` 31 reports hidden; no activation present IPC or claim                                                                           | Before command: `window-hide-applied` 47 → `window-visibility-completed` 48; no activation presentation                                              | [case log](tab-activation-hang/run3/d-stable-hidden-events.jsonl); [first hidden run](tab-activation-hang/run1/d-already-hidden-events.jsonl)                   |

**(a):** `setActivePane` really does set `open:true`. With the dock collapsed, this mounts/re-presents A and completes activation. When the dock is already open on A, the same selection leaves the `AppDockPane` presentation-effect inputs unchanged. Native hide updates presentation state, but the activation callback's same-pane selection produces no new present request. The caller waits until the outer command limit; the screenshot shows the selected Browser dock with an empty body. This distinction matters: “already selected” alone is not sufficient to reproduce the hang.

**(b):** after claim, the renderer does request presentation. The native host applies it while the window is hidden/minimized, so `appTabs.isVisible(A)` remains false. The unchanged main IPC handler therefore does not call `appTabActivation.presented`. Hiding/minimizing does not cancel the pending request in the tested window handlers. The client eventually times out. The before-claim control instead rejects at the existing `canPresent` check.

**(c)/(d):** a normal different-tab selection presents and returns the advertised active/ready result. Already-hidden routing finds no eligible window and returns `TAB_FOLDER_NOT_AVAILABLE`; it does not enter a 30-second activation wait.

## Exclusions and validation

Two additional run-2 attempts were excluded from the requested-case verdicts: the shell became visible again before the held claim was released, and before the supposed already-hidden command. They returned success in **334.708 ms** and **115.802 ms**, respectively. Their logged preconditions did not match stable hiding; the shell show events and successful claim are preserved in [run-2 results](tab-activation-hang/run2/results.json) and [events](tab-activation-hang/run2/events.jsonl). The cause of that re-show was not investigated; no product conclusion is drawn from those attempts.

[Run-1 results](tab-activation-hang/run1/results.json), [run-2 results](tab-activation-hang/run2/results.json), and [guarded run-3 results](tab-activation-hang/run3/results.json) contain exact response objects, full-precision durations, renderer dock state, native owner/visibility, and shell visibility/minimization before and after each command. Hidden-window captures are evidence artifacts, not proof of visible screen content. The committed harness sources allow reconstruction without changing product source. Setup failures involving bundle module format and a missing absolute fixture preload path were corrected before the measured runs.

Existing activation/routing controls: **15 tests passed**. Scoped report formatting passed; workspace lint passed with 622 warnings and zero errors (including diagnostic harness files), and typecheck passed with all 11 Turbo tasks cached. These checks do not establish a standalone typecheck of the scratch harness. Logs are in the evidence directory. [Harness instructions](tab-activation-hang/harness/README.md) document re-running the native cases. Real paid agent turns, the installed Browser UI, physical Cmd-H delivery, multi-window races, and the historical Production trigger remain unverified. No fixes are proposed.
