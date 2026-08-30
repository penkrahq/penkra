# Sample

This complete framework-neutral Penkra App demonstrates a page-owned App Bar, a route that omits
the bar, semantic Theme tokens, a trusted Space-partitioned Settings contribution, a
file-backed operation guide, an optional runtime permission request, an error state, a controller
operation, and an awaited UI handoff. Skills are deliberately absent from this package because the
operation's required usage guidance belongs in leaf help, not an optional workflow.

Run `bun run build` and the repository's ordinary tests. In Penkra, pass the registered `penkra app
test --directory ./dist` and `penkra app package --directory ./dist --output <path>` commands one at a time
through `penkra_exec_command`. They target the deployable `dist` directory—not this source
workspace, which intentionally contains development dependencies—and are not shell executables.
