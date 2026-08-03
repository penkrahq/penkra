# Testing and packaging

Keep business logic in ordinary framework tests. Validate the package boundary with:

```sh
penkra app preflight ./dist --output ./my-app.penkra
penkra app test ./dist
```

Preflight validates the manifest, schemas, documents, paths, compatibility, permissions, and
package bounds. App test creates a temporary profile and Space, ingests the App through the normal
immutable package path, starts its isolated controller and renderer, records diagnostics, and
cleans up. It does not replace unit, accessibility, or visual tests.

The built directory must include `penkra-app.json`, nonempty UTF-8 `README.md` and
`INSTRUCTIONS.md`, icons, entrypoints, and their local assets. Do not package source secrets,
development credentials, symlinks, or files outside the declared build.
