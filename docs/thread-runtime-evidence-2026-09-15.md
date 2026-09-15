# Thread runtime investigation — 2026-09-15

## Scope

This record covers four failures reported against Penkra 0.12.10 and its contemporaneous Dev
build: missing interleaved transcript activity in long Threads, a queued Steer card briefly remaining
after its canonical transcript row appeared, repeated raw Codex MCP transport warnings, and a stale
multi-window Thread binding rejection. It records reproduced mechanisms and test evidence; it does
not assign the historical cause of an occurrence where retained evidence was insufficient.

## Long transcript retention

The live affected Dev Thread returned 5,458 activities and 305 messages from the authoritative turn
page while its renderer retained 1,737 activities and 612 messages and reported detail sync as
`synced`. The first retained activity IDs also differed. This proved that server history was present
and that the renderer had discarded only the activity side of the admitted causal page.

History identified three distinct changes:

- `a38249ffc` introduced client snapshot caps for payload and memory protection. The value 2,000 was
  an implementation estimate, not a transcript invariant.
- `e6aa172ec` made server activity selection turn-aware but did not change every renderer admission
  path.
- `ae4ece5d4`, merged after the 0.12.10 tag, stopped truncating an admitted turn page and subsequent
  activity events, but generic detail reconciliation and new-message admission could still truncate
  the already-loaded page.

The regression first loaded a 2,001-activity causal page, then reconciled a 2,001-row live detail
window. Before the correction, the historical tool activity disappeared. A second regression loaded
2,000 messages and appended one live message; before the correction, the oldest admitted message
disappeared. Both now preserve the complete admitted page. Unmounted summary state remains bounded
and is never labeled as authoritative detail. Explicit whole-detail eviction remains responsible for
releasing memory.

Pagination diagnostics now record the incoming, merged, and actually stored counts, dropped counts,
and first/last stored IDs. Hot-path reconciliation records whether a hydrated window was retained and
the before/incoming/after message and activity counts. These bounded local traces can distinguish a
server omission from a renderer admission loss.

## Steer duplicate frame

The reported screenshot showed one message simultaneously as a transcript row labeled “Steering
conversation” and as a queued composer card with a Steer button. Durable events showed the queue
claim, server steer request, canonical message transition, command acceptance, and claim release in
that order.

The prior browser test sampled only after settled milestones and therefore passed despite a possible
intermediate commit. Committed-frame diagnostics were added for visible queue message IDs, visible
steer message IDs, and their intersection. A timing-controlled regression starts with a persisted
queued draft and queued server message, then publishes `thread.turn-steer-queued-requested` before
the draft cleanup effect runs. Before the correction it captured the same message ID on both
surfaces in one committed frame.

The visible queue is now derived against the canonical transcript placement by message ID. Once a
message is presented as a steer, that ID cannot also produce a queued card in the same render. The
later effect still removes stale persisted draft data, but no user-visible invariant depends on the
effect running before paint. This follows React's documented render/commit model: effects synchronize
after a commit and may run after the browser paints, while external-store snapshots must provide the
state used by a render.

The focused browser matrix covers Codex, Claude Agent, and OpenCode restored queues, delayed command
receipts, requested-before-receipt ordering, repeated clicks, navigation, rejection rollback, and
retry. The controlled duplicate-frame test failed before the correction and passes afterward.

## Codex MCP warnings

The repeated `rmcp::transport::worker` lines are emitted by the Codex child when an MCP transport
closes. They identify neither the configured MCP server nor whether its absence is optional. Penkra
previously projected each raw stderr line as an independent runtime warning.

Codex status responses provide named failure evidence through both `toolsError` and the current
`runtimeStatus` shape. Penkra now frames arbitrary stderr byte chunks into complete UTF-8 lines,
briefly correlates raw transport closure lines with the named status response, and emits one named
warning per failure episode. If status never supplies a name, one redacted raw warning is retained as
fallback evidence. A recovered server clears its episode key so a later failure remains visible.
Process-exit diagnostics keep their existing stderr tail and do not duplicate the correlated runtime
warning.

## Multi-window binding admission

The stale-binding rejection came from trusting a window-local Thread binding revision after another
window advanced the same Thread. Started Threads now refresh the authoritative binding before a send
instead of treating a cached revision as an admission token. The regression uses two revisions and
failed under the cached behavior. Draft and not-yet-started Thread behavior is unchanged.

## Verification

Focused automated verification on the working tree passed:

- Server Codex manager and adapter: 168 passed, 2 skipped.
- Web projection, event reducer, ownership, and binding admission: 148 passed.
- Full browser ChatView suite: 135 passed.
- Browser Steer timing/provider/failure matrix: 8 passed across Codex, Claude Agent, and OpenCode.
- Final repository checks: `bun fmt`, `bun lint` (zero errors), and `bun typecheck` all passed.

A freshly restarted Penkra Dev 3 exercised an actual Codex turn, a queued follow-up, Steer, and Stop.
The accepted Steer was visible as a canonical transcript row, the queued card was absent, and every
committed presentation sample had an empty duplicate-message-ID intersection. The same test was then
repeated with two product windows on one Thread. Both windows converged on the canonical row, neither
retained the queued card, and neither recorded a duplicate committed presentation.

The live long Dev Thread was reloaded after the renderer update. Its authoritative page contained
317 messages and 5,885 activities; the renderer retained all 317 messages and all 5,885 page
activities plus one newer live activity, with matching first IDs and `synced` detail state.

After a fresh Dev 3 backend restart, a real Codex session reproduced the optional `paper` MCP startup
failure. The transcript displayed one named warning and no repeated raw transport-worker warnings;
the provider turn continued. No production build or release includes these corrections at the time
of this record.
