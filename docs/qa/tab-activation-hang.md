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

## Additional investigation: selected-folder feasibility and agent text

Additions (f)–(g), source **a0a576730cacc6a3301c7bdefec3cdae485505cf**, still 0.14.4. Scratch root `/Users/emmanuelgyekyeatta-penkra/Penkra/qa-tab-additions-b9xq3rc4`, profile `qa-home`, backend fixture **3919**, Vite **5919**. No provider calls, SQLite access, installed Penkra access, signing, installation, or product changes in the release worktree. These use the same real command gateway/renderer/native-host harness, with a local instrumented Browser hosted page. The observation resolver and App storage root are fixtures; the production resolver's `LOAD_FAILED` catch wrapper is audited as source, not reproduced.

### Scope update: selected-folder rule

The requested (e) macOS-action classification is withdrawn. The decided rule is: **when a Thread's folder is selected in any Penkra window, agents may use its tabs even if that window is hidden, minimized, on another Space, or covered. Only absence of that folder from all window selections may block for window/folder availability.** This is the target rule, not a claim that the audited source implements it. Previously collected (e) raw evidence remains archival and is not required for the verdict.

The (f) fixture keeps `qa-folder` selected in its one real shell throughout the hidden/minimized cases. Its native visibility changes, but its folder selection does not. Measurements therefore exercise the positive condition of the decided rule. No multi-window, other-Space, or covered-window feasibility conclusion is inferred from them.

### (f) Feasibility of commands under the selected-folder rule

**Feasibility verdict:** text snapshot and Browser click/type/scroll/upload work while the folder's shell is hidden or minimized. For the four tested input actions, the existing native host and input delivery paths needed only the diagnostic bypass of presentation admission/cancellation; no alternative event injection or application focus was added. Turning `backgroundThrottling` off was **not necessary** for successful delivery and did not consistently eliminate the long type delay. This is a measured prerequisite in the scratch fixture, not a proposed product implementation.

**With the normal guard:** text `snapshot` succeeds in hidden and minimized windows with throttling either on or off. `act` click, type, scroll and upload all reject `TAB_NOT_ACTIVE`, `dispatched:false`, `outcome:"not-started"`. No action-specific input event was observed after those commands within the measured interval. This is a bounded observation, not an infinite “never.”

**With the requested scratch-only guard bypass:** all five commands succeed in all four hidden/minimized × throttling cells. Every input effect arrived before restoration; none waited for the user to restore the shell. The bypass returns early only from `AppTabObserver.#requireActive`, including its presentation-change cancellation registration. It does not bypass the visual-capture guard. [Exact scratch patch](tab-activation-hang/additions/matrix/guard-bypass.patch).

| Shell state | `backgroundThrottling` | Snapshot command ms | Click event delay ms | Type input delay ms | Scroll state / event delay       | Upload change delay ms |
| ----------- | ---------------------- | ------------------: | -------------------: | ------------------: | -------------------------------- | ---------------------: |
| Hidden      | on                     |               3.712 |                    6 |                 295 | 400 px immediately; event 6 ms   |                      3 |
| Hidden      | off                    |               3.170 |                    6 |          **11,975** | 400 px immediately; event 983 ms |                      2 |
| Minimized   | on                     |               3.494 |                    7 |                 307 | 400 px immediately; event 8 ms   |                      3 |
| Minimized   | off                    |               3.205 |                    6 |                 296 | 400 px immediately; event 7 ms   |                      2 |

The diagnostic input path still uses live retained App/page WebContents, a fresh accessibility snapshot and references for the current loader, a usable page layout/hit-testable element, and readable regular files for upload. The real `AppTabViewHost` continues its existing retained/detached-view handling. Those conditions held in the fixture; this does not establish delivery if the documents are destroyed, the element is covered within the page, or the upload target/path is invalid.

The documented **activate → snapshot → act** workflow is not demonstrated to work unchanged under the new rule. The measured hidden inputs were called after a fresh text snapshot with the scratch admission bypass; they did not first run successful hidden activation. Original (d) and `g-screenshot-hidden` show that current activation routing rejects a hidden selected-folder window with `TAB_FOLDER_NOT_AVAILABLE`. Record/trace have a separate visual-presentation check that the input bypass does not affect.

| Command family               | Feasibility evidence with folder selected                                                          | Remaining restriction / unverified condition                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| list, text snapshot          | Hidden list succeeds; hidden and minimized snapshots succeed with throttling on/off, normal guard. | Negative case “folder selected in no window” not measured by this matrix.                               |
| act click/type/scroll/upload | All hidden/minimized × throttling cases succeed with the scratch presentation-check bypass.        | Normal source blocks them with TAB_NOT_ACTIVE. Some type calls take about 12 seconds; cause unresolved. |
| evaluate                     | Hidden evaluate executes a scripted click and returns `1` with the normal guard (g).               | Minimized evaluate and arbitrary expression effects not separately tested.                              |
| activate                     | Current hidden selected-folder route rejects promptly in original (d).                             | Successful hidden/minimized activation under the decided rule is unverified.                            |
| screenshot                   | Hidden selected-folder call rejects at activation routing (g).                                     | Input bypass does not bypass that routing; hidden/minimized visual capture feasibility unverified.      |
| record, trace                | Hidden calls reject their visual-presentation check (g).                                           | No visual-check bypass measurement; minimized/background frame production unverified.                   |
| har                          | Hidden capture succeeds with normal guard (g).                                                     | HAR contains zero entries; nonempty network capture and minimized capture unverified.                   |
| close                        | Visible close destroys the retained tab (g).                                                       | Hidden/minimized close not measured.                                                                    |

The hidden repeat produced type latency **11,540 ms with throttling on** and **305 ms with throttling off**. The delay therefore is not demonstrated to depend on the setting. Repeat scroll callbacks took 989 ms/on and 8 ms/off, although scroll position changed before command completion. These are individual measurements, not a performance distribution or a causal diagnosis.

Clicks produced trusted pointer/click events. Type clicked the field, set its value, and emitted **synthetic** `input/change` events (`isTrusted:false`), rather than trusted keyboard text entry. Upload produced trusted file-input events and the expected `upload-fixture.txt`. Snapshot reads do not deliver an input event. “Immediate” here means delivered in the active command/observation interval without restoring the shell; the approximately 12-second type cases are explicitly late.

The main matrix's hosted page reported `document.visibilityState:"visible"` even with the shell hidden/minimized: the real native host can place retained page content in a detached host. In the throttled hidden repeat, the page instead reported `hidden`, and still received the inputs. The measurements include actual page visibility and per-WebContents throttling getters; shell hiding is not assumed to hide every page renderer. State readback can wake a renderer, so this does not measure unattended background timer cadence.

The visible/throttling-on control succeeded. The visible/throttling-off control succeeded for click/type, but lost native presentation before scroll/upload, which then returned `TAB_NOT_ACTIVE`. Its hide diagnostic reported `isVisible:true`. That cell is confounded by the visibility change, not evidence of failure to deliver an otherwise admitted action.

[Exact command and event timings](tab-activation-hang/additions/input-measurements.md), [main matrix](tab-activation-hang/additions/matrix/event-delivery-matrix.json), [repeat](tab-activation-hang/additions/repeat/event-delivery-matrix.json), and [diagnostic/host/CDP/page-event log](tab-activation-hang/additions/matrix/events.jsonl) provide the full evidence. Event attribution filters by action ID and issued timestamp; cumulative page logs also retain prior actions and are not all attributed to the newest command.

### (g) Every agent-facing tab text surface

The [claim-by-claim text audit](tab-activation-hang/additions/text-audit.md) covers the requested SERVER.md section, root help, all **10** subcommand helps, shared invocation/schema wording, examples and every advertised field/action. [125 authored error sites/templates](tab-activation-hang/additions/error-inventory.md) have individual true/false/ambiguous verdicts, with [machine-readable inventory](tab-activation-hang/additions/error-catalog.json). External exception strings are an unbounded family; observed instances and their wrappers are included, and unexercised branches are explicitly ambiguous.

Runtime contradictions include missing advertised `presentation.state`; screenshot selecting a different tab; folder-scoped text reads from another caller Thread; hidden `evaluate` successfully performing a scripted click; `snapshot.depth` advertised as a number but rejected when fractional; and a valid non-file-input reference reported as `STALE_REFERENCE`. Normal `act` input guarding and failure dispatch/completed-step metadata were accurate in the tested cases. The wrong upload target reached CDP and correctly reported **`dispatched:true,outcome:"unknown"`**, despite its misleading stale-reference code.

The artifacts include exact CLI strings/results, a decoded/probed WebM, PNG, snapshot text, Chromium trace, and visible/hidden HAR files. Both HAR files contain zero entries; successful nonempty network capture remains unverified. A requested 500 ms recording took **23,913.780 ms** end-to-end; its media duration was 0.466 seconds. This is one observed startup/capture/encoding measurement, not a change in prescribed capture duration.

Existing controls passed: **62 desktop tests** across observer/upload/activation/routing and **30 CLI tests**. No new product tests or fixes. All scratch Electron/helper processes and the fixture Vite server were stopped. Scoped report formatting passed. Workspace lint passed with **747 warnings, zero errors**; typecheck passed with **11 cached tasks**. Evidence integrity checks passed. These checks do not constitute a standalone typecheck of the diagnostic harness. Multi-window routing/selection, other-Space or covered-window feasibility, background visual capture, hidden/minimized close, all listed source-only failures, unattended background behavior, and the historical Production trigger remain unverified.
