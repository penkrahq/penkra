# Connection-native usage — 2026-10-22

## Source and boundary

Usage reads now resolve the selected managed Connection and active pinned
installation, never ambient credential files or a binary on PATH. The old direct
OAuth HTTP fetchers, credential readers and their feature-specific tests were
removed together. This is not a migration and changes no stored credentials.

Codex uses its existing Connection-owned app-server process: `account/read`
establishes native signed-out state, then `account/rateLimits/read` supplies quota
windows and credits. The pinned contract also establishes that `account/usage/read`
reports token history, not credits; it is not needed by this usage UI.

Claude uses the pinned SDK's native usage control request with that Connection's
managed executable and profile. The existing read-only catalog query owner is
shared rather than duplicated. No persistent conversation is created. Completion,
cancellation, request timeout and failure all close the query and prove child exit.
The request timeout is typed and affects only this request, not later reads or turns.

The server retains one shared snapshot per Connection. Subscription never fetches.
Native quota facts update snapshots directly, without a request/notification loop.
Explicit refresh requests use a separate stream and still trigger a native read.
Cancellation of the outer refresh reaches the native operation.

Only native signed-out evidence yields `needs-auth`. A rejected usage request is
`error`; previously observed quota windows can remain visible without converting
that failure into a successful or reconnect snapshot. API keys and OpenCode remain
unsupported, with no native usage request.

## Verification

- Combined focused run: 168 tests passed across Codex account pooling, Claude
  adapter, usage and maintenance cases.
- Follow-up usage/parser matrix: 22 passed; refresh-stream split: nine passed.
- Codex 0.163.0 real-binary contracts: two passed, 12.29 s.
- Claude 2.1.307 real-binary contracts: three passed, 10.56 s.
- Codex pool tests distinguish two Connections, confirm catalog/process reuse,
  signed-out handling and request-local rejection without terminating the process.
- Claude tests verify exact managed executable/environment, non-persistence,
  timeout cleanup and a successful later read.
- Pure normalization covers native credits, model quota windows, low percentages,
  native unavailability, and failure status alongside retained runtime facts.
- Dev 1 was launched from this checkout (backend PID 90719, port 55229). Computer
  Use verified the signed-in Codex Connection's popup visually: Session and Weekly
  windows displayed, without a reconnect error. This is one real Connection, not
  proof that all production accounts match their provider dashboards.
- Combined server suite: 2,395 passed, one failed, two pre-existing skips across
  360 files, 510.85 s. The sole failure was a newly added assertion proving native
  push source labels accumulated (`test+test` rather than `test`). Commit
  `dad66b6ed` keeps the latest native source label; the complete affected usage and
  refresh-stream files then passed all nine tests. The full suite was not repeated.
- Formatting, lint (869 warnings, no errors) and all 11 typecheck tasks passed
  before the small source-label correction; its two files were formatted and its
  focused tests rerun afterward.

One native-contract invocation failed before running any request because the
implementer supplied `<version>/codex` instead of the pinned `<version>/bin/codex`.
The corrected pinned-binary run passed. An initial refresh-stream test published
before subscribing and waited forever; it was stopped, corrected to register the
listener first, and passed. Neither incident was a provider failure.

Personal credential files were not moved: doing so would interfere with unrelated
live CLI sessions. Isolation is tested through explicit managed profiles and native
process fixtures, with no personal-file input in the product path. Production
installation and multi-account dashboard comparison are not established by this
document.
