# @penkra/sdk

Complete App-development guide:
https://github.com/penkrahq/penkra/blob/main/docs/app-development.md

```sh
npm install @penkra/sdk
```

Framework-neutral APIs for Apps running inside Penkra. The package contains manifest validation,
typed operations, tab routing, settings, secrets, identity, permissions, mediated
network and file access, hosted browser and simulator sessions, and native context menus. Visual
Apps run as sandboxed App×Space-origin iframes connected to the trusted host by a tab-bound
MessagePort. The SDK never exposes Electron, Node globals, raw IPC, or filesystem paths.

```ts
import { defineApp, tab } from "@penkra/sdk";

export const manifest = defineApp({
  manifestVersion: 2,
  id: "com.example.notes",
  slug: "notes",
  name: "Notes",
  summary: "Keep project notes.",
  version: "1.0.0",
  compatibility: { penkra: ">=0.8.0" },
  icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
  entrypoints: { app: "app.html" },
});

// When navigation begins inside the App, record the current route for restoration.
await tab.setRoute({ route: "/note", state: { noteId: "note-123" } });
```

`tab.setRoute` records the visual App's current route and state without navigating it or calling its
`tab.onNavigate` handler. Penkra restores the latest recorded route after an App update or host
restart. `tab.onNavigate` receives navigation initiated outside the App.

Apps may use any browser-compatible framework. React is optional and available from
`@penkra/sdk/react`. Runtime calls throw when used outside a Penkra App renderer; ordinary unit
tests should test App logic separately. Penkra exposes the real isolated-host runner through the
registered `penkra app test <directory>` command in `penkra_exec_command`.

Use `contextMenu.show(...)` from a direct pointer interaction when an App needs a platform-native
right-click menu. Penkra returns the selected item ID or `null`; Apps never receive Electron menu
objects.

Files and directories use `files.pick("file" | "directory")` and opaque App×Space-scoped handle IDs.
The host validates every descendant and symlink boundary and never reveals an absolute path.
Handles survive iframe reload but currently expire when the desktop runtime restarts; there is no
filesystem manifest permission or ambient filesystem namespace. Apps may also declare exact
`open-file` extensions or `open-directory`; trusted host openings deliver the same kind of scoped
handle to the declared operation.

Privileged Penkra APIs require matching manifest declarations and per-Space grants. Hosted browser
APIs require `browser-session`, and hosted simulated-device APIs require `simulator-session`. Both
are scoped to the calling App and Space and cannot address another App or Space's session.

The Browser page is host-owned while the App owns its surrounding chrome. Call
`browser.setSurfaceLayout({ top, right, bottom, left })` with App-local edge insets, or `null` when
the page surface is hidden. Insets describe structural layout and should remain unchanged during a
plain panel resize; do not stream measured width and height through the runtime bridge.
