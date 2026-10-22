# Claude error classification — 2026-10-22

P26 inventory CL 595–664, 1111 and 1172–1206: lifecycle classification now lives in
`apps/server/src/provider/claudeErrorClassifier.ts`; presentation filtering is explicitly separate.

## Reproduction and replacement

Two ordinary `error_during_execution` results, “Failed to interrupt the remote worker” and
“The cancel operation failed”, were classified as interrupted/cancelled by substring checks.
Both adapter tests failed before replacement and pass afterward. Results now use the pinned
SDK's explicit `terminal_reason` (`aborted_streaming` / `aborted_tools`); otherwise an error
remains failed. The existing pending-user-interrupt identity guard remains unchanged.

The native Claude 2.1.307 / Agent SDK 0.3.307 contract confirms an actual interrupted request
reports `terminal_reason: aborted_streaming`. The SDK contract still exercises catalogs,
turns, questions, request rejection, background tasks and a subsequent turn.

An isolated missing-session experiment confirmed both the result error text and the SDK's
thrown envelope: `Claude Code returned an error result: No conversation found with session ID: …`.
The native classifier test initially failed on that envelope, then passed after recognizing
the exact prefix. The retained rule invalidates the dead resume cursor, not arbitrary errors
containing similar words. No user credentials or Production files were used.

Owned child signal/exit fields take precedence over text when distinguishing graceful exits
from forced exits. Text-only SDK exit envelopes are anchored. Effect's actual
`runPromise(Effect.interrupt)` produces a plain Error; its exact interruption message is tested
against the installed Effect dependency. Unrelated prose containing that message is not accepted.

## Verification

- Claude adapter plus classifier: **134 passed**, no skips.
- Full native Claude contract file: **2 passed**, no skips, **7.53 s** overall.
- Before-fix native missing-session classifier: **1 failed**, other contract filtered out.
- Formatting, lint and workspace typecheck run for this change; see commit verification record.

This does not establish every historical stall's cause. These changes are not yet installed
in Production and do not constitute a published release.
