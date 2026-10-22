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

Computer Use reached the installed Production app but reported the Mac locked.
An unlock request was sent to the operator. Post-install visual QA and public
publication are therefore not established by this evidence.

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
not attributed to that service incident. The corrected source must pass CI before
the release workflow is dispatched.
