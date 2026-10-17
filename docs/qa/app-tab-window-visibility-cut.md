# App-tab window visibility cut — 2026-10-17

## Mechanism and change

The historical investigation is in `hosted-view-visibility-regression.md`.
Window hide/show handlers launched asynchronous capture and attachment changes
without ordering them. An old hide could detach a newly presented view; a later
show could skip reattachment. A missing replica frame then appeared as a blank
panel. Switching tabs caused a fresh presentation and masked the failure.

Window visibility no longer mutates App-tab ownership, attachment or presentation.
The shell's hide/show/minimize/restore handlers retain their trace events only.
The owner remains live; another window's presentation remains a replica until
activated. Ordinary tab hide/present, close, overlay freeze and retained-tab hosts
remain. The unused `shouldPresentAppView` predicate and its seven tests were
removed with the obsolete visibility mechanism.

Agent routing and interaction share the same candidate permission: matching Space
and folder, native window visible and not minimized, and not the focused right
panel the user is working in. Candidate permission is independent of which home
window wins routing. Native hide/minimize events notify in-flight actions without
moving views. A permission exception aborts the action rather than escaping the
event listener.

Screenshots require a drawn page. Undrawn-page capture is refused with snapshot
guidance, not stale pixels. No rendering flags, unthrottling, retries or new delays
were introduced. Agent help now describes folders and tabs rather than windows.

## Reproduction and controls

The old presentation predicate returned `replica` for the selected owner when the
window was hidden; the new expected-live test failed before the cut. A controlled
pending geometry read also reproduced an uncaught permission exception from the
presentation listener. Both pass after the change; geometry completion cannot
resume the cancelled input after reactivation.

Native trials used Electron 44.4.1, the actual AppTabViewHost/AppTabObserver,
command pipe and server CLI, default background throttling and real Browser/App
documents. Installation readiness and shell-to-renderer activation delivery were
fixtures. The later activation trials switched from a second real tab and verified
the first tab changed from detached/unselected to selected/native-owned. This is
not certification of the packaged app's complete activation IPC path.

| State                                          | Observed result                                                                                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| On screen, covered-run control                 | 3 each click/type/scroll succeed; real tab activation 344–483 ms; screenshots 27–43 ms                                             |
| Fully covered, page confirmed hidden           | 3 each click/type/scroll succeed; activation 152–171 ms; screenshot refusals 1.2–7.4 ms                                            |
| Other full-screen Space, page confirmed hidden | 3 each click/type/scroll succeed; activation 194–360 ms; screenshot refusals 1.2–2,091 ms                                          |
| App hidden, pre-cut attached-view gate         | 15 input/activate/screenshot refusals, FOLDER_NOT_OPEN, 0.28–1.21 ms                                                               |
| Minimized, post-cut repeat                     | 15 input/activate/screenshot refusals, FOLDER_NOT_OPEN, 2.5–71 ms                                                                  |
| Minimize during typing                         | Aborted; value unchanged; 49.7 ms after the minimize transition completed                                                          |
| Space switch during typing                     | Finished with the exact requested value; 6.71 s overall, 5.23 s after transition (one already-admitted mouse move awaited a frame) |

The slower first off-screen trials are reported, not discarded: click 4,736 ms,
type 1,762 ms and screenshot refusal 2,091 ms. Subsequent commands completed
without the former repeated animation stalls. No latency percentile is inferred
from three trials. Concurrent local build activity makes these unsuitable as an
isolated performance benchmark.

Earlier coordinate checks covered three clicks each after scrolling 0, 200 and a
page height, and three each hover/type on a target initially below the viewport.
All passed. The page had no iframe; existing frame/shadow-root unit coverage was
retained. Screenshot freshness failures and rejected throttling experiments were
not counted as successful captures.

## Numbered Dev visual check

The desktop build and App-controller bundle verification passed. Dev slot 1
restarted from this checkout at 10:39:34 MDT, PID 38668. Computer Use opened Apps
in Personal/Default and visually inspected the painted App grid. Native run
`4586d8970003` recorded hide at 16:41:01.138Z and show at 16:41:23.889Z. Restoring
the same window, without a tab switch, showed the same Apps grid. Tab
`7462297c-6859-4438-9b10-bcac98c79d83` retained its owner and live presentation.
The initial capture while the application was still hidden is not a restore test.

The Mission Control keyboard shortcut was attempted, but its resulting OS state
was not independently established; it is not counted as a Mission Control visual
pass. A full day of operator usage and combined packaged Production QA remain
unproven. Production was neither restarted nor replaced.

## Focused verification

- Desktop observer/routing/view-host/pipe-server: 88 tests passed.
- Server CLI: 30 tests passed.
- `bun fmt` passed; `bun lint`: 0 errors, 866 warnings.
- `bun typecheck`: 11/11 tasks passed.
- Desktop build and controller-bundle verification passed.
- Source grep for `setWindowVisibility`, `setAppTabWindowVisibility`,
  `window-hide-replica` and `windowVisible` is empty in desktop/web source.

Native probe processes were stopped. The ignored fixture/evidence root remains
documented until combined QA can consume the measurements; no QA App bundle was
installed and no Production database was opened.
