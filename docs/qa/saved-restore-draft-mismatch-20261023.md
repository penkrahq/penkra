# Saved restore / empty composer investigation

Observed in Production Strategy: the accessibility tree shows the editor's value
empty, Send disabled, Saved count 1, and the non-empty-draft refusal toast.
No Production draft was changed or database opened during this investigation.

Controlled reproduction in `composerDraftSync.test.ts` (temporary diagnostic,
removed afterward rather than asserting defective behavior permanently):

1. Load a committed draft containing `old text`.
2. Supply an empty local draft and reject `setThreadDraft` with `Connection lost`.
3. Assert `flush()` resolves successfully despite the rejection.
4. Restore a successful API and supply the same empty draft again.
5. Assert no second write occurs and the backend still contains `old text`.

All assertions reproduced: 12/12 tests, 2026-10-23 15:39 MDT.
`writePending` sets `knownPayload` before acknowledgement and discards failure;
`setLocalDraft` then suppresses that same payload as already known.

Restore also reads the store without flushing the editor's 50ms pending update
and calls the backend without awaiting its 300ms draft synchronization.
The backend correctly refuses to overwrite a non-empty stored draft. The browser
restore fixture does not implement this refusal, leaving that integration gap
untested. Existing save-and-restore success coverage cannot establish safety here.

These mechanisms are established from source and the controlled reproduction.
Existing Production logs do not establish which one caused this Strategy event.

## Correction and verification

Draft synchronization now records only the server's acknowledged payload. A
failed write rejects an explicit flush and retains the latest pending edit;
subsequent flushes remain usable. A server response rejecting an older write
is not reported as a successful save, and a newer remote draft is applied only
if no newer local edit arrived. Background saves remain debounced, without an
automatic retry loop.

Saved restore and queued-message Edit first project pending editor text into
the draft store, await draft persistence, and refuse the move if the local draft
changes while awaiting persistence or staging attachment bytes. The server's
transactional non-empty check is unchanged.

Verification:

- 14 draft-sync tests pass, including failed clear/retry, edits arriving while a
  preceding write fails, and a stale write rejected in favor of another window.
- Real Chromium ChatView test passes save, type another draft, clear it, restore,
  and verify restored text/no provider dispatch. The fixture now implements the
  same non-empty guard as the real server instead of silently overwriting drafts.
- Workspace formatting, lint (existing warnings, no errors), and typecheck pass.
- The preceding Saved-popup correction has two passing browser tests and native
  Dev visual verification with Browser still visible alongside Saved.

## Local Production installation

Signed arm64 local build, unchanged version 0.14.5. Build completed in about
5m29s. First updater attempt stopped before changing Production because its
temporary watcher test used nonexistent `/bin/true`. The subsequent canonical
updater invocation used the correct macOS executable paths and completed.
No product changes were made for that local scripting error.

- Receipt: `~/Penkra/.penkra/updates/20261023-155125-164845/report.md`, UPDATE OK;
  detached agent exit 0.
- App PID 43499, backend PID 43508, port 52235; independent `/status` check:
  `{"version":"0.14.5","migration":{"status":"ok"}}`.
- Candidate and installed ASAR SHA256:
  `f05433abb842d09747aebce8d4b7e354943e0a62f1751234a2280a3a4940e8f6`.
- Offline canonical database verification passed. No schema changes or database
  restoration. Previous bundle retained by the canonical updater.
- Native screenshot confirmed the populated sidebar and composer after relaunch.
  No user draft or saved prompt was cleared/restored for Production QA; a further
  navigation attempt was interrupted by concurrent user activity.
- No version bump, public release, or published-asset replacement.
