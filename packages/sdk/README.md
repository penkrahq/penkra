# @penkra/sdk

Framework-neutral APIs for Apps running inside Penkra. The package contains manifest validation,
typed operations, tab routing, scoped files, settings, secrets, identity, permissions, mediated
network/process access, and hosted browser sessions. It never exposes Electron or Node globals.

```ts
import { defineApp, files, tab } from "@penkra/sdk";

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

tab.onNavigate(async ({ state }) => {
  if (state?.handleId) console.log(await files.readText(state.handleId));
});
```

Apps may use any browser-compatible framework. React is optional and available from
`@penkra/sdk/react`. Runtime calls throw when used outside a Penkra App renderer; ordinary unit
tests should test App logic separately, while `penkra app test` validates the packaged App in the
real isolated host.

Privileged APIs require matching manifest declarations and per-Space grants. File APIs accept only
opaque handles chosen or handed off by the user. Hosted browser APIs require `browser-session` and
cannot address another App or Space's pages.
