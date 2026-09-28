# Thread stall candidate composition — 2026-09-28

This is a local, unreleased candidate based on the 0.14.1 release source. It has no approved next
version and is not installed in production.

| Commit      | Included change                                                                                                                                                      | Status                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `0a9b6d76d` | Remove the mandatory fresh desktop QA gate from contributor instructions                                                                                             | Committed                                                           |
| `465d1e53f` | Record slow command-worker, runtime-event, provider-call, SQLite, event-loop, health, and bootstrap stages; retain controlled coupling tests and production evidence | Committed; diagnostic only                                          |
| `8d9168c99` | Preserve the general diagnostics and thread-runtime isolation designs and the historical failure-site inventory                                                      | Committed design for review; no behavioral architecture implemented |

The source tag `v0.14.1` already includes confirmation before archiving one thread and before
archiving all threads in a project. The primary checkout's Sidebar difference adds split-view
behavior; it is unrelated to the archive-confirmation requirement.

The primary checkout currently has 83 dirty paths. Forty-one matched this candidate byte for byte
when compared during the audit; the other 42 differed or were missing. The active `dev-consolidated`
checkout has seven server source differences from the 0.14.1 tag. Those checkouts contain separate
work in progress and have not been copied into this candidate. Their changes require individual
feature ownership and acceptance evidence before inclusion in any release.

The local candidate does not include the proposed transactional provider outbox, independent
provider-session lanes, per-lane runtime-event projection, command-worker redesign, socket-admission
isolation, or the separate general diagnostics store and trace system. No production root cause has
been proven for the intermittent health/WebSocket admission delay or Strategy's Claude start phase.
The diagnostic build must first be installed in an approved release and capture a matching recurrence
before a historical production cause can be claimed.

Verification on this candidate: server typecheck and build passed; provider reactor tests passed
(165/165); the focused orchestration, ingestion, event-loop, and transport run passed (182/182);
format and patch whitespace checks passed. Direct `bun test` is not the repository's runner and
fails SQLite safety because its embedded SQLite is 3.51.0; the supported Node/Vitest runner uses
SQLite 3.53.3.
