# Sample

This complete framework-neutral Penkra App demonstrates a page-owned App Bar, a route that omits
the bar, semantic Theme tokens, a trusted Space-partitioned Settings contribution, a
Space-scoped Agent Skill, an optional runtime permission request, an error state, a controller
operation, and an awaited UI handoff.

Run `bun run build`, then `penkra app test dist` and
`penkra app package dist --output sample.penkra`. Test and package the deployable `dist`
directory—not this source workspace, which intentionally contains development dependencies.
