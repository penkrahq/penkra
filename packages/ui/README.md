# @penkra/ui

Penkra's framework-neutral visual contracts for compatible Apps. It provides semantic tokens,
icons, and App Bar primitives without requiring React or allowing Apps to style trusted shell
chrome.

```js
import { createAppBar } from "@penkra/ui";
import "@penkra/ui/tokens.css";
import "@penkra/ui/app-bar.css";

const bar = createAppBar({
  leading: [{ id: "back", label: "Back", icon: "arrow-left" }],
  center: { kind: "input", value: "", placeholder: "Search" },
  trailing: [{ id: "more", label: "More", icon: "more-vertical" }],
});
document.body.prepend(bar.element);
```

`@penkra/ui/react` adapts the same contracts for React. Apps inherit the host's semantic Theme
tokens and should use those tokens instead of detecting or hardcoding a Penkra preset. Apps can
omit the App Bar on any page or provide their own UI; they cannot replace the trusted Panel tab
strip or other shell surfaces.
