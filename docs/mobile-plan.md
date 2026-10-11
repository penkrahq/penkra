# Penkra Mobile v1 (iPhone): plan for operator approval

Status: DRAFT, 2026-10-11. Nothing here is built until the operator approves it (TODO 4.3).

## Decided (operator)
Native iPhone app only. Tailscale is embedded in both the Mac and the phone; there is no separate install. We run our own Headscale and relay on the Penkra backend server (`connect.penkra.com`, `relay.penkra.com`). Sign-in uses Penkra accounts (`api.penkra.com/auth`). Push notifications ship in v1.

## Screens (`readme-assets/mobile-v1-screens.png`)
1. **Sign in** with the Penkra account.
2. **Pick your Mac** from the Macs signed in to the same account. The first time, the Mac shows an approval request.
3. **Threads** for the chosen Mac, filtered by folder, with a status dot: working, needs your answer, or idle.
4. **Chat:** a live transcript with tool rows shown compact. The composer steers or queues using the same five send results as the Mac (TODO 2.4). It also has an interrupt button.
5. **Answer a question:** the open questions from TODO 2.5.
6. **Push notifications** for "needs your answer" and "finished".
7. **Mac offline:** a banner while the Mac is asleep or offline, with the last loaded state shown read-only. Sending is disabled until the Mac is back.

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
1. Is "Sign in with Apple" wanted? Its availability in our Better Auth setup is not verified.
2. Is v1 limited to the screens above?
3. Does the Apple Developer account and App Store, or TestFlight only, cover v1 distribution?
