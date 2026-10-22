# Local Production package — 2026-10-22

Operator requested continuing through a local Production update. Version remains
0.14.4; no tag, push, public release, App publication or version bump was performed.
This is an installation/evidence record, not a claim that every item in TODO is complete.

## Source and native preservation

Candidate source: `cd3c14957dee18aa2b59c33451287295a4f4cf76`.
`a6b81d020` integrates Connection-owned OpenCode processes/storage. Existing native
generations are exported and verified after import before source deletion. A failed
copy or selection commit retains the source. Exact native ownership guards reject
duplicate Thread claims; deletion visits registered profiles, including signed-out
ones, without borrowing account credentials. The preceding transfer contracts cover
attachments, output files, snapshot trees and actual native undo after source removal.

Integration checks: nine changed files, 113 tests passed; final four focused files,
79 tests passed; pinned OpenCode/native lifecycle contracts both passed (37.25 s
test time). Root formatting, lint and type-check passed.

## Final checks and defects found

- Full server pass: 2,345 passed, 13 failed, one suite failed to load, two existing
  opt-in tests skipped. Seven failing files were corrected and rerun: 68 passed.
  Failures were stale migration lists, historical-schema tests inadvertently running
  newer migrations/current readers, missing Saved Prompts fixture data, missing
  credential-admission Effects, a missing process diagnostic fixture, and assertions
  expecting the explicitly removed automatic Codex respawn. Native exit-proof and
  failure-preservation assertions remain; a later independent admission starts again.
- Full web unit pass: 2,052 passed, two failed. The two tab fixtures were corrected
  to take shared navigation from the canonical tab record. Final changed web unit
  files: 35 passed, including two new cut-off ordering cases.
- Full browser pass: 331 passed, three failed. The transcript fixture still returned
  a boolean instead of per-steer segment arrays; the menu fixture expected an
  on-open usage request rather than server-pushed snapshots. The cold-history check
  bypassed outline pagination and used turn timing where P17 specifies segment timing.
  The final targeted rerun passed all four selected cases (88 filtered, not new skips):
  interrupted-command expansion, cold history, Saved Prompt restore and pushed usage.
- A genuine P17 defect was reproduced: with no final answer and no steer, a settled
  fold sorted at sequence zero, above unrelated history. The new unit test fails on
  the previous implementation. The fold now uses its existing turn/steer position;
  the steer case, no-steer case and mounted interrupted-command case pass.
- Production compilation caught a Saved Prompt conditional inside `try/catch` that
  made React Compiler bail out of ChatView. Moving operation selection outside that
  block preserves behavior and restores compilation. The final production web build
  verified all four hot-path compiler contracts; the guard was not weakened.
- Final `bun fmt` passed; `bun lint` reported 869 warnings, zero errors;
  `bun typecheck` passed all 11 tasks. Migration lineage check passed against all
  136 released tags. Full suites were not repeated after targeted corrections.

## Package and update boundary

Canonical `build-desktop-artifact.ts --platform mac --target dmg --arch arm64
--local-sign --keep-stage` completed in about five minutes for the final source.
Strict deep Developer ID verification passed, Team `Q3DX82J2GK`.

ASAR SHA-256: `3c8831dc8069607aab2916c4168a3b227b1d8ba6b390be16948ee15dab627413`.
Required Apps 0.2.10: source `93b2ae9a1d0bc5285d357e317c3d5d4dea742cfe`,
package digest `a541ff967066e9e57b7b829093f4b8798342fe9a34476ac8e750199838931c16`.
Local `spctl` result 3 is informational for this unnotarized, non-quarantined build.

Updater invoked only through `scripts/update-production.sh`; detached transaction:
`~/Penkra/.penkra/updates/20261022-063748-879724/`.
Its final report and fresh installed readiness checks establish the outcome, not
the launcher's acknowledgement. No live Penkra database was queried or copied by
the implementation agent. Offline verification and any migration backup belong to
the canonical updater/app lifecycle.

## Installed outcome

The detached updater reported **UPDATE OK** at 06:43:47 MDT. Installed ASAR matched
the candidate hash above. App PID 6878 and backend PID 6888 survived both launch
helper and transaction-session exit. Fresh runtime metadata identifies port 64024
and start `2026-10-22T12:43:12.598Z`; `/status` returns 0.14.4 and migration `ok`.
Migration 213 ran after a verified app-owned v212 backup. Backup creation took
about 16 seconds; readiness was reached about 68 seconds after app launch.
The updater retained the old bundle and exact rollback snapshot in their canonical
locations; no rollback was needed.

Computer Use verified restored Main/WorkApp folders and their chats, history,
composer, Saved Prompts control, live Working timer and a new running Codex turn.
The Browser renderer loaded. The existing Apps tab opened its catalog, showing
Mail, Explorer, Browser, Canvas, Apps and installed WorkBase variants; the
catalog and transcript were also visually checked in the screenshot. Existing
user work was not replaced with a synthetic QA conversation. Two stale-action
attempts were refused by Computer Use's user-change guard; a fresh native-state
read and immediate action succeeded. No input guard was disabled or bypassed.

The unused first candidate/artifacts were moved to Trash (recoverable), not left
in Applications. Disposable final staging/artifacts are removed from active scratch
after updater exit; canonical rollback files are retained.
