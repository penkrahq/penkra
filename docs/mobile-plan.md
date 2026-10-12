# Penkra Mobile v1 (iPhone): plan for operator approval

Status: DRAFT, 2026-10-11. Nothing here is built until the operator approves it (TODO 4.3).

## Decided (operator)

Native iPhone app only. Tailscale is embedded in both the Mac and the phone; there is no separate install. We run our own Headscale and relay on the Penkra backend server (`connect.penkra.com`, `relay.penkra.com`). Sign-in uses Penkra accounts (`api.penkra.com/auth`). Push notifications ship in v1.

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

- **Mac side:**
  - Penkra joins the account's tailnet using embedded `tsnet`.
  - The server listens on its tailnet address only.
  - The server's existing auth (`apps/server/src/auth`: bootstrap credential, then a session credential) pairs the phone after the user approves on the Mac.
  - Pairing reuses the existing `remoteAccessPolicyError` rules. The tailnet supplies the encryption, so no public URL is needed.
- **Phone side:**
  - Swift/SwiftUI with `libtailscale`.
  - It talks to the same WebSocket RPC as the web client and reads the clean-core `threads` / `thread_items`.
- **Push:**
  - The Mac posts turn-finished and question-opened events to `api.penkra.com`, which sends them to APNs.
  - A notification carries the thread title and one line of text only.
- **Server side:**
  - Headscale and the relay run as containers behind `nginx-proxy` on 49.13.149.60, on 443.
  - UDP 3478 is opened when the relay is deployed.
  - Headscale's users map to Penkra accounts.

## Open for the operator

None. Distribution: TestFlight first (operator).
