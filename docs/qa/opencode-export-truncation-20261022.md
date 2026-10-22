# Chore native export failure — 2026-10-22

## Observed incident

Production 0.14.4, backend PID 6888, started at 2026-10-22T12:43:12.598Z.
Thread `919c1fb3-9437-4431-ba0e-e90f3c836dd5` (Chore) failed two admitted
deliveries at 15:37:43.755Z and 15:37:58.973Z. Both failed while starting,
before a `provider.delivery.wire_input` record for the new messages.
The UI was inspected in the actual `/Applications/Penkra.app` window and showed
the same export error and two failed, undelivered messages.

The installed migration path introduced in `a6b81d020` exports a resumed
conversation from its old generation before importing it into shared Connection
storage. It parses captured CLI stdout as JSON. On export failure the source is
not deleted. The error wrapper retains a cause in memory but the delivery log
records only its generic top-level message.

## Exact-source reproduction

Penkra's live database was not opened. The lifecycle-locked canonical maintenance
report read the existing verified pre-migration v212 backup and identified:

- Connection: `4ff2640b-8447-41f8-aac9-5a5a9548469b`.
- Native generation: `2aac4676-0283-42f1-ad27-19f189adcb96`.
- Native session: `ses_f2297bda1ffe0QrBBnikfilOc5`.
- Source native database size: 57,077,760 bytes.

The same pinned OpenCode 1.19.3 executable, exact session, environment, cwd and
`--pure export` arguments were compared under Node 24:

| Output transport                        | Bytes received | JSON / native ownership validation  |
| --------------------------------------- | -------------: | ----------------------------------- |
| Child stdout pipe                       |         65,536 | Unterminated string; invalid JSON   |
| Child stdout directly to a regular file |     19,416,475 | Valid exact session; 1,301 messages |

An earlier Bun-hosted pipe capture returned 655,360 bytes and was also incomplete.
The variation supports output truncation, not a fixed Penkra payload limit.
The CLI returned success in both transports. Reading the same conversation through
regular-file output passed Penkra's existing exact-session/message/part-owner validator.
The temporary export was mode 0600 and was removed after validation. No import,
source deletion, thread-state repair, new message, restart or app replacement was performed.

This directly reproduces the failure mechanism on the affected native conversation;
the original failing process's exact captured byte count was not logged.

## Upstream evidence and coverage gap

[OpenCode issue 14948](https://github.com/anomalyco/opencode/issues/14948) reports
large exports being truncated through pipes while regular-file redirection succeeds.
[Issue 29330](https://github.com/anomalyco/opencode/issues/29330) records the same
class of failure and additional buffer/backpressure experiments.
The pinned [export implementation](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/cli/cmd/export.ts)
writes serialized conversation JSON to stdout.

The existing native contract exercised small conversation export/import and native
artifact preservation, not an export larger than pipe buffers. The new storage
migration made that incomplete coverage consequential for this existing large chat.
This is a Penkra regression exposing an upstream transport defect, not an account
authentication or upstream model-response failure. It does not establish that every
other OpenCode request/stream uses or suffers this export path.

## Corrected path and verification

Every migration/copy export, including post-import verification, now uses one
regular-file export helper. It owns the child process and private temporary file,
validates the exact session and message owners, and removes the temporary output
only after child exit proof. A failed exit proof retains ownership for explicit
runtime shutdown. Logs record phase, byte count, duration and native session ID,
never JSON excerpts containing private transcript text. No OpenCode source changes,
output-size guesses, retries or alternate export paths were introduced.

The actual product helper exported the same affected native conversation:
19,416,475 bytes, 1,301 messages, 1,425 ms. This was read-only with respect to
native conversation state; no import or Production restart occurred.

- 100 focused OpenCode tests passed, including immediate exit with large UTF-8
  output, invalid JSON, wrong owner, spawn/exit failure, cancellation, cleanup and
  failed exit-proof retention.
- Both pinned OpenCode 1.19.3 native contracts passed (61.87 s). One imports,
  exports and verifies a conversation over 8 MiB through this product helper;
  the existing concurrent-directory/tool/image/artifact contract also passed.
- The maintenance ownership-report addition passed its nine tests, including
  live-plus-archived ownership, deleted-thread exclusion and lifecycle locks.
- The latest combined focused run passed 168 tests in seven files. Formatting,
  lint (869 existing warnings, zero errors), and all 11 typecheck tasks passed.

These results validate the implementation, not installation. Production still
contains the old path until the signed candidate is installed and checked there.
