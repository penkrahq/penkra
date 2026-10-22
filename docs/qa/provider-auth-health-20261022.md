# Provider authentication health — 2026-10-22

P26's health-output classifier review reproduced two false classifications:
structured authenticated output plus unrelated “unknown command” / “authentication required”
stderr was classified unknown before the structured result was read. Both added tests failed
before changing the classifier and pass afterward.

Broad unsupported-command and signed-out substring checks have been removed from Codex and
Claude health classification. Structured results take precedence. For pinned Claude, successful
command execution without authentication JSON no longer proves the account is authenticated.
Malformed or unrecognized output remains unknown; its actual diagnostic is preserved.

The pinned Codex 0.163.0 CLI's `login status --help` exposes no JSON option. An isolated real
signed-out command exits 1, writes no stdout and writes exactly `Not logged in\n` to stderr.
That exact envelope is recognized, while arbitrary remote-tool wording is not. Codex's existing
structured-output interpretation and exit-zero behavior remain unchanged. Claude 2.1.307's real
signed-out command exits 1 and supplies a JSON `loggedIn: false` field.

Native contracts now verify both signed-out envelopes directly against the pinned executables.
They run in temporary isolated homes and do not use the operator's logins or Production files.
Existing fake Codex signed-out fixtures were corrected to use the native stderr channel;
unsupported-command tests now assert request diagnostics rather than guessed capability state.
No tests were deleted or skipped to make the change pass.

Verification:

- ProviderHealth: **64 passed** (1.59 s).
- Full native Codex contract file: **2 passed** (10.78 s).
- Full native Claude contract file: **3 passed** (9.18 s).
- `bun fmt`: passed.
- `bun lint`: 868 warnings, zero errors.
- `bun typecheck`: 11 successful tasks.

This verifies classification, not every historical account incident. The existing timeout
stabilizer and its message-based timeout recognition were not changed in this commit. No
Production replacement, version bump or publication occurred.
