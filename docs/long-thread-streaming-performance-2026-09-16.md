# Long-thread streaming performance evidence (2026-09-16)

## Reported failure

Penkra Dev streamed visibly more slowly in a Thread whose newest hydrated page contained 331
messages and 5,580 activities. During live output the main renderer sustained roughly 50–100% of
one CPU core and grew above 1 GB resident memory; the backend and provider process remained light.

## Reproduction

The browser reproduction mounts the complete ChatView with 20 turns, 300 assistant messages, and
5,500 tool activities interleaved by causal sequence, then publishes ten successive assistant-text
revisions to the final running turn. It captures bounded development-only timings for the
transcript commit and each major projection.

The original code reproduced the allocation mechanism directly: appending one activity recreated
every public work-log entry in the retained history even though the underlying historical activity
objects were unchanged. The focused identity test failed before the fix and now covers Codex,
Claude, and OpenCode inputs.

Representative Chromium measurements from the same 25-update harness before the fix:

| Work                               |    p50 |        p95 |
| ---------------------------------- | -----: | ---------: |
| Transcript work-log projection     | 1.1 ms | 1.3–1.8 ms |
| Composer-strip work-log projection | 1.0 ms | 1.2–1.6 ms |
| Transcript React commit            | 8.8 ms |     9.5 ms |

After preserving public work-entry identity, canonical reasoning presentation identity, and the
row reconciler's reference fast path:

| Work                               |    p50 |    p95 |
| ---------------------------------- | -----: | -----: |
| Transcript work-log projection     | 0.6 ms | 0.7 ms |
| Composer-strip work-log projection | 0.5 ms | 0.5 ms |
| Agent/reasoning projection         | 0.3 ms | 0.3 ms |
| Timeline row derivation            | 0.6 ms | 0.7 ms |
| Transcript React commit            | 9.6 ms | 9.9 ms |

These numbers describe this controlled development build and are comparative evidence, not a
product timing threshold.

The rebuilt Penkra Dev app was also sampled with the reported Thread mounted while that Thread had
more than 5,000 retained activities and was actively receiving this investigation's output. Across
15 one-second process samples, the main renderer was ordinarily at 19–26% CPU and about 0.85 GB RSS,
then fell to 0.5% CPU when publication paused. The original live failure sustained roughly 50–100%
CPU and climbed past 1 GB RSS. This live check corroborates the controlled reproduction without
turning either observation into a product heuristic or fixed performance gate.

## Root cause and fix

`deriveActivityWorkLogEntry` already cached the payload-heavy private projection by immutable
activity identity. The final private-to-public conversion then used object rest syntax on every
call, discarding that identity and allocating thousands of replacement objects per publication.
Downstream agent-activity projection and React reconciliation consequently treated stable history
as fresh input throughout a live stream.

The public conversion now has its own weak identity cache. The agent-activity projection likewise
weak-caches presentation derived from an immutable work entry, so historical Codex reasoning text
is not cleaned and cloned again on every publication. Timeline row reconciliation accepts an exact
work-entry reference without rereading its payload fields. A changed or merged private entry still
produces a new public value, while unchanged history reuses its prior value. Weak keys preserve the
existing lifetime: removing an activity or derived entry does not pin it in memory.

Development diagnostics now time transcript commits, both work-log projections, agent-activity,
pending-interaction, workflow, context, timeline, and row derivation. They remain disabled unless
explicitly enabled through `window.penkraChatPerformance`, retain at most 500 samples, and record no
message or activity payloads.

## History and regression boundaries

Commit `1a74bc344` added the private per-activity cache but the public clone remained. Commit
`332d3d8ba` changed visible sync publication from a microtask to a 50 ms batch; that cadence predates
this regression investigation and remains unchanged because it is a separate product tradeoff
between latency and renderer load across windows. PR #40 (`b5eb8945e`) retained complete admitted
transcript history, which made the pre-existing identity loss materially more expensive on long
Threads but did not create it.

The fix changes neither history retention nor ordering, collapse, interaction settlement,
multi-window synchronization, provider ingestion, or the 50 ms publication policy. Focused tests
exercise the failing long-running shape, stable-prefix identity for all providers, and the existing
work-log behavior suite.
