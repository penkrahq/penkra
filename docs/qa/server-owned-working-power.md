# Server-owned working state and native power

2026-10-17. P5 replaces renderer-derived thread activity with one private,
desktop-token-authenticated NDJSON stream. Its initial state and subsequent
invalidations read non-deleted running threads without an open question. The same
IDs drive native display-sleep prevention and agent-cursor cleanup. Renderers
report voice only. Backend readiness owns reconnects; no retry timer was added.

## Evidence

The observed Production failure had a running thread but no Penkra sleep
assertion, while desktop logs reported empty renderer activity. This change
removes those renderer caches from the thread-work decision entirely.

- Server route: 3 focused tests pass, including real HTTP authentication,
  initial state without windows, questions/deletion, reconnect and changed IDs
  with an unchanged count.
- Desktop: 12 focused tests pass, including voice ownership, EOF, malformed and
  truncated NDJSON, HTTP failure, and a replaced stream ending after its successor.
- Workspace format, lint and typecheck pass (0 lint errors, 865 warnings;
  11 typecheck tasks).
- Real Electron probe, PID 56173, no BrowserWindows: macOS `pmset -g assertions`
  lists that PID's `NoDisplaySleepAssertion` for a working set, removes it when
  the set empties, lists it again on renewed work, and removes it on stream EOF.
  The probe exits successfully. Its HTTP source is a fixture; its client and
  power-blocker implementation are the product modules.

The first probe incorrectly used a synchronous OS command immediately after
starting the native blocker. That blocked the event loop while observing native
work. The second used asynchronous execution but matched the system-wide name
against process rows: macOS calls the owning process's assertion
`NoDisplaySleepAssertion`. Correcting the probe to inspect that exact PID and
native assertion name produced the recorded pass. No product delay or retry was
introduced. Electron's documented API is
[powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker).

## Limits

This is not the full-app, longer-than-display-timeout operator gate. Numbered Dev
and the combined packaged Production candidate still require that validation.
Production was not replaced for these checks.

Deleted with this design: `DesktopActiveWorkPowerSync`, `activeWorkPower.ts`,
its renderer-derivation tests, the old per-owner thread/snapshot merging and its
tests, and the old active-work IPC. The unrelated background-thread view helper
retains its existing behavior locally in `desktopThreadState.ts`; it no longer
participates in power policy.
