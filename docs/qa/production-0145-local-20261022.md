# Local Production 0.14.5 — 2026-10-22

## Installed candidate

- Source: `a91166cacf3bf2e66e129ef6b9a8232090565381`.
- Version: 0.14.5, explicitly approved by the operator.
- Developer ID: Students in Demand Inc., Team `Q3DX82J2GK`.
- Deep strict signature verification passed before and after installation.
- Installed ASAR SHA-256:
  `307a4ed990ce2cc0724a6107d43bbe66d6c6bc248ad0ef2608f7f98dde020a5c`.
- Embedded required Apps: 0.2.10, digest
  `a541ff967066e9e57b7b829093f4b8798342fe9a34476ac8e750199838931c16`.
- App PID 7913; backend PID 7921; port 59781; runtime started
  `2026-10-22T16:44:57.466Z`.
- Registered `/status` returned version 0.14.5 and migration status `ok`.

The canonical updater reported `UPDATE OK`, including independent exact-process
verification after the launch helper exited. Its retained report and rollback app
are under `~/Penkra/.penkra/updates/20261022-104151-549649/`.
The packaged maintenance verifier ran only after all Production owners exited:
SQLite 3.53.4, 22 tables, 203 migration records, 596 threads, 763,975 items.
No migration backup event occurred and no database restoration or repair was needed.
The retired-keybindings step found no file and moved no preferences.

The initial `fcaf20f36` package was superseded by the bounded usage-source fix.
Its generated stage and artifacts were moved to recoverable Trash entries
`penkra-0145-superseded-{stage,artifacts}-20261022T1639`; they were not installed.
The final active build root has a README and remains needed for release validation.
No QA backup app was installed in Applications.

## Validation boundaries

See `opencode-export-truncation-20261022.md` for the exact Chore reproduction and
native export/import contracts, and `connection-native-usage-20261022.md` for
usage isolation and combined server checks.

Chore contains two failed deliveries requesting cancellation of LinkedIn Premium
and a refund. Neither was replayed as a diagnostic; sending another message there
can also deliver those existing requests. The exact 19.4 MB native conversation
was validated read-only, not resumed into a financial/account action.

Computer Use initially reported the Mac locked; after the operator's continuation,
it reached the installed app and captured the actual window. The Apps gallery
rendered in its right panel, the sidebar and transcript were populated, and a live
Claude Strategy response showed Working/Thinking and streamed text. A later read
showed Strategy Done and Codex Service actively running tools with Working/Thinking
and a stop control. These were existing user turns, not diagnostic messages sent by
the implementer. The operator continued using the app during observation, so no
interaction-performance benchmark or exhaustive UI pass is claimed.

## CI correction

CI run `39815659021` passed server, both browser partitions, static contracts and
desktop build/compiler checks. Workspace tests failed on the running-work client's
UTF-8/EOF fixture: its fake fetch returned the same Response again, whose body was
already locked by the first read. The same eight-test file reproduced locally
(one failed, seven passed). Returning a fresh empty Response for the second HTTP
request preserves the intended successful reconnect case without changing product
behavior or suppressing errors. The complete desktop suite then passed: 1,050
passed, five existing skips, 159 files, 4.93 seconds. No new tests were skipped.

GitHub's Actions status was degraded during this run; API snapshots also lagged
completed job results. The actual workspace failure above is independent evidence,
not attributed to that service incident. The corrected source
`7b2eeebfe7fb5bc8354702d4c03e3be75225707f` passed all seven CI checks in run
`39817199021`. Its only differences from the installed runtime source are the test
fixture and this evidence document. The approved 0.14.5 release was dispatched as
run `39818766814`; publication is not established by dispatch alone.

## Official notarized bundle installed

The macOS arm64 job of that release run completed successfully in 7m55s. Its
`penkra-0.14.5-mac-arm64` artifact was downloaded and every file's size/SHA-256
matched `artifact-mac-arm64.provenance.json`. Source identity is the exact
`7b2eeebfe7fb5bc8354702d4c03e3be75225707f` release commit. ZIP SHA-256:
`a0ec6692cc86c5f1dcf83afff12d37303e3502c6fa92229c48e3466329b7fe6a`.
The extracted app passed deep strict codesign verification, Gatekeeper
(`accepted`, `Notarized Developer ID`) and `stapler validate`.

The canonical same-version updater then installed this official bundle and
reported `UPDATE OK` under
`~/Penkra/.penkra/updates/20261022-111153-298698/`. App PID 16930, backend PID
17025, port 64316, started `2026-10-22T17:13:19.098Z`; independent `/status`
reported 0.14.5 and migration status `ok`. Installed ASAR SHA-256:
`814eacb690b8760ae5f5b575a4ecd3f6619ccbc18269cdd50a7c602c44cabc61`.
Installed Gatekeeper assessment again accepted the Notarized Developer ID.
No database migration, restoration or preference-file move occurred.

The operator's own Chore submission also passed native transfer, verification,
wire delivery and running-state transitions on the first 0.14.5 candidate; see
`opencode-export-truncation-20261022.md` for exact correlated records. The official
swap deliberately stopped that turn with reason `app-quit`; it was not silently
classified as an upstream failure or replayed by the implementer.

## Public release and final checks

[Release 0.14.5](https://github.com/penkrahq/penkra/releases/tag/v0.14.5) became
public stable at `2026-10-22T17:16:36Z`, titled `Penkra v0.14.5`, with 17 assets.
The immutable tag targets the exact certified `7b2eeebfe` source. All four platform
builds, assembly and publication succeeded in run `39818766814`:

| Job         | Duration |
| ----------- | -------: |
| macOS arm64 |    7m55s |
| macOS x64   |   14m44s |
| Linux x64   |    8m19s |
| Windows x64 |    7m13s |
| Assembly    |      55s |
| Publication |       5s |

Dispatch to completed workflow: 16m49s. Intel macOS was the critical build path;
these are observations of this run, not a before/after performance claim.

The unauthenticated GitHub latest-release API returned `v0.14.5`. The public
`latest-mac.yml` contains both arm64 and x64 0.14.5 update ZIPs. Public asset digests
match the official arm64 ZIP/DMG verified and installed above. The existing Windows
manual-only/unsigned notice was preserved; release notes also identify provider
runtime versions and the principal changes.

Computer Use opened the installed app's native **Check for Updates** command.
`desktop.log` correlates the menu request at `17:18:16.466Z`, native completion at
`17:18:18.011Z` with installed/latest both 0.14.5, and successful pending-cache
cleanup. Thus the app's real updater discovered the published version; this is not
inferred solely from a reachable manifest. A final screenshot of the official app
showed its populated transcript, composer, sidebar and Apps gallery.

The website's Mac download route initially returned 0.14.4 at 17:20:13Z. The
actual `penkra-website/app/download/[platform]/route.ts` has an existing 300-second
GitHub release cache; at 17:21:03Z it returned 0.14.5. Subsequent HEAD checks of all
four observed platform routes matched their exact 0.14.5 installer assets. No
website code or hosting deployment was changed. Separately, the website still
advertises Windows automatic updates despite the current manual-only distribution;
that pre-existing copy mismatch is not represented as fixed by this desktop release.

Generated local staging, downloaded release artifacts, extracted official bundle
and the bounded reproduction harness were moved to recoverable Trash entries
`penkra-0145-local-stage-20261022T1725`,
`penkra-0145-release-artifacts-20261022T1725` and
`penkra-opencode-export-repro-20261022T1725`. No active process held the candidate
ASARs before the move. Existing Trash contents, installed apps, databases, native
conversation data and updater rollback bundles were not removed. This clears the
task's workspace roots; it is not a claim of physical disk reclamation.
