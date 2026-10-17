# Expanded-turn boundary reproduction

2026-10-17. Controlled Chromium component experiment against the in-progress P4
client. This is not evidence that the installed Production build has this newly
introduced paging mechanism; Production remains unchanged.

## Trigger and result

`TranscriptVirtualList.browser.tsx` has three explicit boundary scenarios:

1. Short history: two rows initially, six total. A rendered boundary loads until
   exhaustion and disappears. Pass.
2. Top-level history: two rows initially, 200 total. Paging stops when the
   boundary leaves the rendered range. Pass.
3. Expanded turn: the same 200-row sequence, preceded by fixed user/header rows.
   Paging consumes all 200 rows while its boundary remains visible, and React
   reports maximum update depth. Fail, repeated twice after the top-level fix.

The intended P4 rule is implemented literally: each rendered boundary asks for
another page, and is re-evaluated after each load. In scenario 3, older rows are
inserted below the turn header/boundary. Keeping that header in place also keeps
the boundary rendered, so no later page can move it out of range. The test's
assertion `loaded < 200` fails with `loaded === 200`.

The fixture uses two-row pages to exercise many transitions quickly; the product
page size remains 50. It uses real Chromium layout and the product virtualizer,
not a mocked range. No providers, accounts, database changes, sleeps or product
timeouts are involved. The screenshot captured before teardown is retained at
`.penkra/scratch/p4-render-boundary/expanded.png`; the ordinary failure screenshot
after fixture unmount was blank and is not visual evidence.

## Mechanism checks

The first top-level experiment also failed because a boundary was treated as
content and could request pages before initial placement completed. A boundary
now has zero layout height, cannot be the first content identity used to detect
prepend, and the first range report is driven by placement resolution. Subsequent
range reports use the virtualizer's actual rendered range, including overscan.
Those changes make scenarios 1 and 2 pass, but do not solve scenario 3.

The installed TanStack Virtual Core `setOptions` implementation captures the
first visible keyed item when end anchoring is enabled. For scenario 3 that can
be the unchanged header, not the steps into which older items were inserted.
Changing only the prepend detector therefore does not establish correct detail
sequence anchoring.

No failing test was skipped or committed, no retry/threshold workaround was
added, and the candidate was not installed in Production.

## Approved anchoring amendment

The amended P4.4 preserves the previously oldest loaded step, rather than a
header above the insertion. The sequence controller captures that row before
applying an older page; the list reuses its reader-anchor snapshot and restore
mechanism in the layout pass. Range reports wait for that restoration, preventing
an intermediate range from requesting another page. Newest-page refreshes and
duplicate pages do not capture a prepend anchor.

The three original boundary reproductions now pass. A fourth uses the actual
50-row page size against 200 steps: initial expansion has 50 loaded steps;
successive upward scrolls produce exactly 100, 150, then 200. At every insertion,
the previously oldest step remains exactly 80 pixels below the viewport top
(the fixed user/header pair's height). No extra page is consumed between those
scrolls. These are component page requests, not measured provider or Production
RPC calls.

The complete virtual-list browser file passes 26 tests, including restored
viewports, dynamic measurements and tail-follow cases. An initial attempt to
apply same-pass correction to initial viewport restoration also changed a giant
row's measurement sequence; that adjacent regression was caught by its existing
test. Same-pass correction is now limited to a resolved viewport receiving a
prepend; initial restoration retains its measurement-driven scheduling.

Production remains unchanged; this is not a packaged/manual QA claim.

## Actual timeline integration: grouped-step identity failure

The next check used `deriveMessagesTimelineRows`, not the virtual-list fixture.
Fifty consecutive tool items at sequences 152–201 produce one work row whose
key is `item-152`. Prepending sequences 102–151 produces one work row keyed
`item-102`; `item-152` no longer exists as a virtual row. The regression test
`retains the previously oldest displayed step when an older details page is
inserted` fails on that missing identity. The previously passing virtual-list
fixture kept one stable row per step, so it did not establish this property for
the actual timeline.

The work renderer also folds that combined row into nested command summaries,
or caps its openly rendered entries at six. Thus appending older steps inside
the same combined row does not necessarily add their visible height, even if its
key were changed to a stable last-item key. That key change alone cannot satisfy
the approved boundary-leaves-range rule.

This is an uncommitted failing reproduction. No test is skipped, no Production
change is made, and the candidate is not ready for installation. P4.4 specifies
which sequence and anchor to preserve, but does not specify whether its existing
nested tool summaries are removed within expanded settled-turn details or how
those grouped rows are partitioned for paging.

## Option B implementation and integrated checks

The subsequent approved amendment preserves summary appearance but makes the
summary and each opened member separate virtual rows. Summary identity uses the
newest step. The bundled `groupedEntries`, `leadingWorkEntries`,
`inlineWorkEntries` and `collapsedTurnItems` fields and their nested renderer
paths are removed. Summary labels/classification remain owned by the existing
tool-call summary helper; its 16 focused tests remain in place.

The real controller/renderer browser check found an additional race not exercised
by the list-only fixture: an unrelated render between anchor capture and page
application could restore against the old rows and clear the anchor prematurely.
Its before trace showed a restore of `step-102` at index 3, before its older page
committed, followed by a jump from 100 to 200 loaded steps. Boundary keys now carry
the actual page cursor. The existing reader-anchor restore waits until that
captured boundary is replaced or exhausted, establishing the page-commit event
without a timer or guessed threshold.

The integrated browser test now uses `createThreadItemsController` and
`MessagesTimeline` together: one details read when Worked-for is expanded;
opened summary members are sibling list rows; successive boundary visits reach
100, 150 and 200 loaded steps with exactly four 50-step reads total. The retained
`flat-summary.png` was visually inspected and shows the separately rendered steps
and the four-read/200-step counters. This is a Chromium fixture, not Production.

The five changed browser files pass 39 checks together. Temporary fixture logging
was removed so it no longer changes a diagnostic switch shared with other browser
tests. The giant-row fixture was also made deterministic: it changes DOM geometry
after the commit measurement and captures the reader before ResizeObserver
delivery, rather than relying on that ordering happening incidentally. Its original
semantic-anchor and geometry assertions remain. No failing test was skipped.
A separate state-store reproduction proved
an empty authoritative outline retained deleted turn companions; it now removes
those turns, finals, has-steps flags and cached details with the deleted rows.

An additional integrated assertion measured actual anchor pixels, not just read
counts. It reproduced a 290-pixel drift (101 → -189) as previously estimated rows
above the anchor received their real heights. A prepend now keeps the existing
reader anchor active for those size adjustments; acquiring the tail for new
content clears that anchor. The same test now preserves the measured position
through each page and still records four reads. The virtual-list tail-follow and
restored-viewport checks pass alongside it.

## Earlier candidate checks

99 focused server tests pass, covering the provider bridge/consumer, OpenCode
adapter and outline/detail reads. 86 focused web tests pass, covering question
mapping/answer helpers, sequence stores/controllers, server-defined timeline
rows and activity normalization. Format and lint pass (zero errors, 862 warnings),
and workspace typecheck passes all 11 tasks. These checks do not replace the
failing expanded-turn browser scenario or combined packaged/manual QA.

Four OpenCode test failures were reproduced against unchanged HEAD source.
Commit `738bf6440` had removed snapshot-watchdog completion, abort-idle polling
and automatic stream reconnects without updating their tests. The interrupt
fixture now supplies native idle rather than waiting for deleted polling; the
stream-end test checks one terminal failure rather than deleted retries; the
two deleted watchdog/recovery tests are removed. The resulting adapter file
passes 62 tests. No watchdog or reconnect loop was restored.
