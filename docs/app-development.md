# App development

Penkra Apps are isolated web applications. React is optional: `@penkra/sdk` and `@penkra/ui` are
framework-neutral, while `@penkra/sdk/react` and `@penkra/ui/react` are convenience adapters.

- `@penkra/sdk`: manifest validation, operations, runtime APIs, permissions, and tab routing.
- `@penkra/sdk/react`: hooks over those same runtime contracts.
- `@penkra/ui`: semantic Theme tokens, accessible SVG assets, and the DOM App Bar.
- `@penkra/ui/react`: React App Bar and icon adapters using the same CSS contract.
- `create-penkra-app`: vanilla or React scaffolding that refuses to overwrite existing work.

Vanilla:

```js
import { tab } from "@penkra/sdk";
import { createAppBar, createIcon } from "@penkra/ui";
const bar = createAppBar({
  center: { kind: "display", text: "Canvas" },
  trailing: [{ key: "search", label: "Search", icon: () => createIcon("search"), onActivate() {} }],
});
document.body.prepend(bar.element);
tab.onNavigate(({ route, state }) => openRoute(route, state));
```

React:

```tsx
import { useTabNavigation } from "@penkra/sdk/react";
import { AppBar, PenkraIcon } from "@penkra/ui/react";
export function Page() {
  useTabNavigation(({ route, state }) => openRoute(route, state));
  return (
    <AppBar center={{ kind: "display", text: "Canvas", icon: <PenkraIcon name="search" /> }} />
  );
}
```

See `examples/sample-app` for present/absent App Bar routes, Theme adaptation, settings, an
optional permission, error UI, an operation with awaited UI, tests, and packaging.

Build before testing or packaging so only the deployable App directory crosses the package
boundary:

```sh
bun run --cwd examples/sample-app build
penkra app test examples/sample-app/dist
penkra app package examples/sample-app/dist --output sample.penkra
```

`penkra app test` launches the built directory in a temporary profile through the real isolated
Electron App host, verifies that its tab reaches `ready`, records diagnostics, and removes the
profile. `penkra app preflight` combines that host test with deterministic package validation.

Continue with [Publishing and sideloading](./app/publishing-and-sideloading.md) for the complete
publisher, public/private registry, invitation, submission, validation, and local sideload command
reference.
