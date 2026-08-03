# Operations and tabs

An operation executes in one isolated controller for the App and Space. Its input and output are
validated against the immutable manifest schemas. `context.caller.kind` is host-asserted as
`user`, `agent`, `app`, or `host`; caller identity is never exposed.

When an invocation includes `tabId`, `context.tab` addresses exactly that validated App tab.
Use `context.tab.invoke` for an in-place UI function and `context.tab.navigate` to change its App
route. Without a target, use `context.tabs.open` to create a new tab. Use the `ForResult` variants
only when the operation genuinely waits for human input. Cancellation arrives through
`context.signal`; tab close, timeout, disable, uninstall, and host shutdown are explicit reasons.

Apps may invoke another enabled App's published operation through `context.operations.invoke`.
The callee's schemas and permissions still apply. Apps cannot invoke Apps' private installation
operations.

Agents call the single registered `penkra_exec` tool. Core commands begin with `penkra`, for
example `penkra open --url https://penkra.com`. App commands begin with the App slug, for example
`linear issues create --title "Fix redirect" --tab-id <id>`. `--help` shows typed flags and
`--schema` adds the full validated schemas. These strings are registered commands, not shell text.
