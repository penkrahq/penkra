# Build a Penkra App

A Penkra App is an installed web application with a visual entrypoint and an optional isolated
operation controller. It runs without Node integration in a sandboxed renderer. Start with
`create-penkra-app`, then use this guide in order:

1. [Manifest](manifest.md)
2. [Runtime and permissions](runtime-and-permissions.md)
3. [Operations and tabs](operations-and-tabs.md)
4. [Agent observation and interaction](agent-observation.md)
5. [UI, Themes, and App Bar](ui-and-themes.md)
6. [Testing and packaging](testing-and-packaging.md)
7. [Publishing and sideloading](publishing-and-sideloading.md)

Penkra Apps can use React, Vue, Svelte, Solid, vanilla DOM, or another browser-compatible stack.
The public contract is the manifest plus `@penkra/sdk`; private Electron objects are never part of
the App API.
