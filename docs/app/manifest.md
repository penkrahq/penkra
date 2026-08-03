# Manifest reference

Every package root contains `penkra-app.json`, `README.md`, `INSTRUCTIONS.md`, the declared icon,
and every declared entrypoint.

Required manifest fields are `manifestVersion`, immutable reverse-domain `id`, globally unique
command `slug`, display `name`, one-line `summary`, semantic `version`,
`compatibility.penkra`, `icons`, and `entrypoints.app`. `entrypoints.operations` is required when
the App publishes operations.

`permissions` declares a standardized permission name, whether it is required, and a specific
user-visible reason. `operations` declares an App-local dotted key, summary, bounded JSON Schema
input/output, and controller handler key. `contributions.handlers` may associate an operation with
`open-url` schemes, `open-file` extensions, or `open-directory`. Settings and Skills are purely
declarative contributions interpreted by the host.

Operation keys are local, such as `issues.create`; do not prefix them with the App slug. Penkra
addresses the operation as `{ app: "linear", operation: "issues.create" }` and presents it to an
agent as `linear issues create` inside `penkra_exec`.

Package paths are relative, must stay within the immutable package, and cannot be symlinks.
Compatibility declares host versions; it grants no permission.
