# Penkra Mobile v1 (iPhone): plan for operator approval

Status: DRAFT, 2026-10-11. Nothing here is built until the operator approves it (TODO 4.3).

## Decided (operator)

Native iPhone app only. Sign-in uses Penkra accounts (`api.penkra.com/auth`). Push notifications ship in v1. The current connection architecture is in `TODO.md` §7.2.

## Screens (`readme-assets/mobile-v1-screens.png`, source `mobile-mocks/`)

Same look as the desktop app: dark theme, Penkra mark, provider icons, the sidebar's status marks (spinner working, amber ? needs you, blue check done).

1. **Sign in:** Penkra account by email. "Sign in with Apple" is shown but not functional in v1 (operator).
2. **Choose your Mac:** Macs on the account; first time, approve on the Mac.
3. **Spaces, folders, threads:** the desktop sidebar on the phone. Space headers (collapsible), folders, threads with provider icon and status, Show more, search, new thread. Tabs: Threads, Needs you, Settings.
4. **New thread:** "What should we do in <folder>?" with the desktop composer: folder and Mac, access mode, model, effort, voice, send.
5. **Chat (live):** transcript, compact tool rows, queued messages, steer/queue composer, stop.
6. **Answer a question** (TODO 2.5).
7. **Model and effort sheet:** models from the Mac's Connections, effort, access.
8. **Push:** needs your answer, finished.
9. **Mac offline:** last loaded state read-only, sending disabled.
10. **Settings:** account, Mac, notifications, sign out.

Goal: TestFlight with all of the above working (operator, 2026-10-11).

## Not in v1

Right-panel Apps, the diff viewer, terminals, settings beyond sign-out and choosing a Mac, iPad, Android, and attachments other than photos.

## Architecture (the operator approves before implementation)

> **Superseded 2026-10-21 (operator): no Tailscale.** The phone reaches the Mac through `relay.penkra.com` with end-to-end Noise encryption. The full design is `TODO.md` §7.2.

## Open for the operator

None. Distribution: TestFlight first (operator).
