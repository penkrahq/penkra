# Thread stall candidate composition — 2026-09-28

This is a local, unreleased candidate based on the 0.14.1 release source. It has no approved next
version and is not installed in production. The intended release candidate combines the targeted
diagnostics and the runtime fixes; the user chose this composition on 2026-09-28. This is a
composition decision, not approval to release an unfinished build.

| Commit                  | Included change                                                                                                                                                      | Status                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `0a9b6d76d`             | Remove the mandatory fresh desktop QA gate from contributor instructions                                                                                             | Committed                                                           |
| `465d1e53f`             | Record slow command-worker, runtime-event, provider-call, SQLite, event-loop, health, and bootstrap stages; retain controlled coupling tests and production evidence | Committed; diagnostic only                                          |
| `8d9168c99`             | Preserve the general diagnostics and thread-runtime isolation designs and the historical failure-site inventory                                                      | Committed design for review; no behavioral architecture implemented |
| `93b8abe9a`–`beff7306e` | Commit provider intents transactionally and run them in bounded durable provider-session lanes, with legacy cutover and blocker recovery                             | Committed locally; unreleased                                       |
| `05babd490`             | Process provider runtime events in bounded per-thread lanes and commit each lane's cursor independently                                                              | Committed locally; unreleased                                       |
| `0d16d2037`             | Prepare orchestration commands in bounded per-aggregate lanes                                                                                                        | Committed locally; unreleased                                       |
| `da2818ade`–`a2e2d2a5b` | Preserve exact terminal turn evidence across start/ingestion races, including after runtime-journal pruning                                                          | Committed locally; unreleased                                       |
| `74ccbad03`             | Correlate runtime reconciliation commands, activity, and failed write stage by attempt ID                                                                            | Committed locally; unreleased                                       |

The source tag `v0.14.1` already includes confirmation before archiving one thread and before
archiving all threads in a project. The primary checkout's Sidebar difference adds split-view
behavior; it is unrelated to the archive-confirmation requirement.

The primary checkout currently has 83 dirty paths. Forty-one matched this candidate byte for byte
when compared during the audit; the other 42 differed or were missing. The active `dev-consolidated`
checkout has seven server source differences from the 0.14.1 tag. Those checkouts contain separate
work in progress and have not been copied into this candidate. Their changes require individual
feature ownership and acceptance evidence before inclusion in any release.

The local candidate includes the transactional provider outbox and independent provider-session
delivery lanes, per-thread runtime-event projection lanes, and parallel command preparation.
It does not yet include a safe urgent stop/interrupt path around a stuck provider start, a short
version-checked command commit with durable ordered publication, socket-admission isolation, or
the separate general diagnostics store and trace system. These are different levels of work:
the targeted probes in `465d1e53f` are included, but the broader diagnostics design in
`8d9168c99` remains a design. No production root cause has been proven for the intermittent
health/WebSocket admission delay or Strategy's Claude start phase. A future recurrence captured
by an installed instrumented build is needed to attribute those historical symptoms.

Verification through `a2e2d2a5b`: server and repository typechecks passed; the provider reactor
suite passed (167/167), including the start/terminal race and pruned-journal fallback; the runtime
ingestion suite passed (153/153); the focused command engine suite passed (26/26); outbox
persistence tests passed (2/2); migration lineage passed across 134 shipped tags. These checks
do not establish release readiness while the stop and shared commit boundaries remain open.
Direct `bun test` is not the repository's runner and fails SQLite safety because its embedded
SQLite is 3.51.0; the supported Node/Vitest runner uses SQLite 3.53.3.

After `74ccbad03`, server typecheck and the reconciler test file (2/2) passed. The installed
production 0.14.1 backend does not contain that attempt-ID change. At 08:55–08:56 UTC on
2026-09-28, its latest journal metrics repeatedly returned to zero backlog; five `/health`
requests completed in 3–415 ms, and five direct WebSocket bootstraps opened in 0–8 ms.
Earlier in the same live log, the journal intermittently fell hundreds of events behind and
reported multi-second SQLite waits and transactions. These measurements establish an
intermittent condition, not the owner of the historical socket delay.
