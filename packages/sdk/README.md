# @penkra/sdk

Complete App-development guide:
https://github.com/penkrahq/penkra/blob/main/docs/app-development.md

```sh
npm install @penkra/sdk
```

Framework-neutral APIs for Apps running inside Penkra. The package contains manifest validation,
typed operations, tab routing, settings, secrets, identity, permissions, mediated
network access, hosted browser and simulator sessions, and native context menus. It never exposes
Electron or Node globals.

```ts
import { defineApp, tab } from "@penkra/sdk";

export const manifest = defineApp({
  manifestVersion: 1,
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

Files and directories use the browser's standard `showOpenFilePicker`, `showSaveFilePicker`, and
`showDirectoryPicker` APIs directly. Native `FileSystemHandle` objects may be persisted in the App's
IndexedDB; there is no Penkra filesystem namespace or filesystem manifest permission.

Privileged Penkra APIs require matching manifest declarations and per-Space grants. Hosted browser APIs require `browser-session`,
and hosted simulated-device APIs require `simulator-session`. Both are scoped to the calling App
and Space and cannot address another App or Space's session.
