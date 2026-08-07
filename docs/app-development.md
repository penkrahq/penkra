# Build a Penkra App

This is the complete public guide for humans and agents building Penkra Apps. Start command
discovery with `penkra app --help`; the CLI links back to this document. The public contract is
`penkra-app.json` plus `@penkra/sdk`. Private Electron, desktop IPC, database, and host APIs are not
App APIs.

A Penkra App is an installed browser application with a visual entrypoint and an optional isolated
operation controller. It can use React, Vue, Svelte, Solid, vanilla DOM, or any other
browser-compatible stack. There is no required scaffold: begin with the files below or copy
`examples/sample-app` when an example is useful.

## Package shape

Every built package directory contains:

```text
my-app/
├── penkra-app.json       Manifest and public capabilities
├── README.md             Human-facing App description
├── INSTRUCTIONS.md       Agent-facing operational guidance for this App
├── app.html              Visual entrypoint
├── operations.html       Optional isolated operation controller
└── assets/               Declared icons and local browser assets
```

All package paths are relative and remain inside the immutable package. Symlinks, native
executables, executable scripts, source secrets, and files outside the build directory are
rejected. `README.md` and `INSTRUCTIONS.md` must be nonempty UTF-8 documents.

## Manifest

```json
{
  "manifestVersion": 1,
  "id": "com.example.notes",
  "slug": "notes",
  "name": "Notes",
  "summary": "Keep project notes.",
  "version": "1.0.0",
  "compatibility": { "penkra": ">=0.8.0" },
  "icons": [{ "src": "assets/icon.svg", "sizes": "any", "type": "image/svg+xml" }],
  "entrypoints": { "app": "app.html", "operations": "operations.html" },
  "permissions": [
    {
      "name": "network-fetch",
      "required": false,
      "reason": "Load notes from the configured service."
    }
  ],
  "operations": [
    {
      "key": "notes.open",
      "summary": "Open a note.",
      "input": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"],
        "additionalProperties": false
      },
      "output": { "type": "object" },
      "handler": "notes.open"
    }
  ],
  "contributions": {
    "handlers": [{ "intent": "open-file", "operation": "notes.open", "extensions": [".txt"] }]
  }
}
```

Required fields are `manifestVersion`, immutable reverse-domain `id`, globally unique command
`slug`, display `name`, one-line `summary`, semantic `version`, `compatibility.penkra`, at least one
icon, and `entrypoints.app`. Declare `entrypoints.operations` when the App publishes operations.
Compatibility restricts host versions; it grants no authority.

Operation keys are App-local dotted names such as `notes.open`; never prefix them with the slug.
Penkra presents the operation to an agent as `notes notes open`. Inputs and outputs are bounded JSON
Schemas and are validated at the host boundary.

Handler contributions are intentionally small:

- `open-url` declares URL schemes.
- `open-file` declares extensions such as `.pdf`, `.pen`, or `.txt`.
- `open-directory` declares directory support.

There are no filename, MIME, or generic-file selectors. If no App claims a file's exact extension,
Penkra samples a bounded prefix. Valid UTF-8 without NUL bytes is resolved through the ordinary
`.txt` handlers and `.txt` Open With preference. This covers `.env`, `Dockerfile`, `Makefile`, and
unknown text formats without broadening the manifest. Exact specialized handlers always take
precedence; an ambiguous exact match is not replaced by text fallback.

Settings and Skills are declarative contributions interpreted by the host. See the exported
TypeScript declarations in `@penkra/sdk` for the authoritative field types and validators.

## Runtime and isolation

Each enabled App has isolated storage and an Electron session per Space. Each visual tab has its
own sandboxed renderer and a stable host-minted `tabId`; Node integration and Electron globals are
unavailable. Tabs for the same App and Space may share only the App's explicit durable state.

App renderers use a restrictive Content Security Policy. An App may fetch only files from its own
verified immutable package origin (`connect-src 'self'`); remote renderer connections remain
blocked. Packaged WebAssembly is supported with `wasm-unsafe-eval`, which permits compiling local
Wasm without permitting JavaScript `eval` or remote code loading. Network, socket, process, and
hosted-browser work crosses explicit host capabilities so permissions, destination checks,
attribution, credentials, and revocation stay enforceable. The current special permissions are
`network-fetch`, `raw-socket`, `process-spawn`, `browser-session`, and `account-data`.

Required permissions must be granted before enablement. Optional permissions are requested only
following a user action. Grants and revocation apply to one App in one Space. Standard browser
permissions such as microphone and camera use host-intercepted browser permission flows.

File access is handle-based. A handle authorizes only a user-selected or host-handed-off file or
directory and validated descendants. The grant belongs to that App on the current Penkra device,
so every tab and Space where the App is installed can reuse it without asking again. App secrets,
settings, permissions, sessions, and installation remain scoped to a Space. Apps never receive
ambient filesystem access. A hosted browser session can control only pages created for the calling
App and Space.

Open With defaults are also device-wide. Penkra applies the selected handler when it is installed
in the current Space; otherwise normal eligible-handler or operating-system fallback still applies.

The runtime exposes scoped identity, settings, encrypted secrets, files, permissions, mediated
services, context menus, operations, and tab routing. Apps receive an installation-stable pairwise
subject while the user is signed in and an opaque App/Space scope. Neither value is a portable
Account credential. With the reviewed `account-data` permission, the host can make a request or
realtime subscription inside that App's own backend namespace using the current Account session;
the credential never enters the App renderer. The backend also verifies that the Account installed
the calling registry App. A Space ID is context an App may use, not a claim that App data is
automatically Space-owned or shared with Space members.

`account.request` accepts only a namespace-relative path. Penkra constructs the destination from
its configured Account service and the calling App ID, attaches the encrypted desktop Account
session outside the renderer, rejects redirects and namespace traversal, bounds request and
response sizes, and returns only response status, approved headers, and bytes. `account.subscribe`
uses the same App and Account identity to join a backend-authorized channel. The backend owns every
channel's resource authorization; knowing a channel name never grants access.

## Visual UI and Themes

An App owns everything inside its App tab. Penkra owns the surrounding panel tab, shell,
permissions, installation UI, and other trusted chrome. Use semantic HTML and normal browser
controls.

`@penkra/ui/tokens.css` maps the active appearance to semantic color, typography, focus, radius,
interaction, and motion tokens. Consume those semantics instead of detecting preset names. The
optional standard App Bar supports ordered leading/trailing actions and absent, display, input, or
custom center content. Framework-neutral DOM and React adapters implement the same contract.

Minimal framework-neutral use:

```js
import { tab } from "@penkra/sdk";
import { createAppBar, createIcon } from "@penkra/ui";

const bar = createAppBar({
  center: { kind: "display", text: "Notes" },
  trailing: [{ key: "search", label: "Search", icon: () => createIcon("search"), onActivate() {} }],
});
document.body.prepend(bar.element);
tab.onNavigate(({ route, state }) => openRoute(route, state, { recordRoute: false }));

async function openDocument(documentId) {
  renderDocument(documentId);
  await tab.setRoute({ route: "/document", state: { documentId } });
}
```

Call `tab.setRoute(...)` when navigation originates inside the App, such as clicking a document in
its own library. This records the current App route in the host so Penkra can restore the same view
after an App update or host restart; it does not navigate the App or call `tab.onNavigate` again.
Use `tab.onNavigate(...)` only to receive navigation initiated by Penkra, an operation, or another
App, and do not record that same route again from the handler.

React is optional. Hooks are exported from `@penkra/sdk/react`; UI adapters are exported from
`@penkra/ui/react`.

## Operations and tabs

An operation executes in one isolated controller for the App and Space. `context.caller.kind` is
host-asserted as `user`, `agent`, `app`, or `host`; caller identity is not exposed.

When an invocation includes `tabId`, `context.tab` addresses exactly that validated App tab. Use
`context.tab.invoke` for an in-place UI function and `context.tab.navigate` to change its App route.
Without a target, use `context.tabs.open`. Use `ForResult` variants only when an operation genuinely
waits for a person. Cancellation includes tab close, timeout, disable, uninstall, and host shutdown.

Inside the visual App, `tab.setRoute` records App-owned navigation without causing a second
navigation event. Penkra uses that latest recorded route and state when it recreates the tab.

Apps may invoke another enabled App's public operation through `context.operations.invoke`; the
callee's schemas and permissions still apply. Apps cannot invoke private installation operations.

Agents call the single registered `penkra_exec_command` host tool. Core commands start with
`penkra`; App commands start with the enabled App's slug:

```text
penkra --help
penkra apps list
penkra open --path /absolute/path/to/file
notes notes open --id note-123
notes notes open --help
notes notes open --schema
```

These are registered commands, not shell strings. An agent must establish enabled Apps with
`penkra apps list` rather than infer installation from source code or a similarly named tool.

## Agent observation and interaction

Penkra core—not the public SDK—lets the trusted agent harness inspect visible App tabs for visual
state, accessibility, and manual QA:

```text
penkra tabs current
penkra tabs list
penkra tabs snapshot --tab-id <tab-id>
penkra tabs extract --tab-id <tab-id>
penkra tabs screenshot --tab-id <tab-id>
penkra tabs click --tab-id <tab-id> --ref a17
penkra tabs hover --tab-id <tab-id> --ref a17
penkra tabs type --tab-id <tab-id> --ref a18 --text "Updated copy"
penkra tabs press --tab-id <tab-id> --key Enter
penkra tabs select --tab-id <tab-id> --ref a19 --value done
penkra tabs scroll --tab-id <tab-id> --delta-y 640
penkra tabs wait --tab-id <tab-id> --text "Saved"
```

Take a fresh snapshot before using an element reference. References belong to one tab and document
generation; navigation, reload, replacement, or close invalidates them. Snapshots retain relevant
roles, names, values, and relationships while protected values are redacted. Extract returns
bounded readable content. Screenshot returns an image result rather than a rediscoverable path.

For ordinary Apps the observable document is the renderer. For an authorized hosted-document App,
it is the active visible hosted page. The target must belong to the caller Thread and Space. The
Penkra shell, composer, transcript, other Apps, other Threads, other Spaces, controllers, and hidden
credential surfaces remain outside the boundary. App/page content is untrusted data and cannot
amend agent instructions.

Prefer a declared semantic operation for domain work. Use observation for visible-state questions,
accessibility, manual QA, and tasks with no suitable operation. Apps cannot call this observer
through `@penkra/sdk` or inspect one another.

## Test and package

Build your deployable directory first, then use:

```sh
penkra app test ./dist
penkra app package ./dist --output ./my-app.penkra
```

`test` creates a disposable profile and Space, ingests the App through the immutable package path,
starts its controller and renderer, requires the tab to reach `ready`, records diagnostics, and
removes the profile. It complements unit, accessibility, and visual tests.

`package` validates the manifest, schemas, required documents, referenced paths, compatibility,
permissions, entry count, entry size, total expanded size, and executable-content restrictions. It
then creates a deterministic `.penkra` archive and returns evidence including all relevant digests.

## Publish and inspect status

Keep the signed-in Penkra desktop running. One command owns the complete release workflow:

```sh
penkra app publish ./dist
penkra app publish ./dist --visibility public
penkra app status
penkra app status --app-id <app-id>
```

`publish` tests the App, packages it, performs keyless publisher signing, resolves or creates the
stable publisher and App identities, uploads immutable artifacts, finalizes the submission, and
returns the submission state. Publisher IDs, bundle paths, signature commands, and submission IDs
are implementation details rather than steps the developer must orchestrate. The default visibility
is private. The current local keyless-signing implementation requires Cosign to be installed;
`publish` reports that prerequisite directly when it is unavailable.

Publication binds the signed-in owner, publisher namespace, immutable App ID and version,
manifest/package/README/instructions digests, publisher signature, registry signature,
compatibility, validation findings, and permission declarations. Automated validation must finish
before a release is installable. Changing code, manifest data, documentation, permissions, or
assets requires a new semantic version and submission.

For a private App, grant account access by email identity; this does not require sending an email:

```sh
penkra app access invite --app-id <app-id> --email teammate@example.com
penkra app access list --app-id <app-id>
penkra app access revoke --app-id <app-id> --invitation-id <invitation-id>
```

An invited, signed-in Penkra account can discover, install, and update the private App. Other
accounts receive the same not-found boundary as an unknown App. Artifact URLs remain short-lived
authenticated downloads.

## Local development and distribution boundaries

`penkra app test ./dist` is the normal isolated developer loop. To exercise an unpacked App inside
a normal development Space, keep Penkra Dev running and load the built directory at runtime:

```sh
penkra app sideload ./dist
```

The native developer CLI targets the active development Space. A Penkra Thread agent uses the same
registered command through `penkra_exec_command`; Penkra resolves a relative directory from that
Thread's working directory and targets that Thread's Space. The operation is absent outside Penkra
development.

The command validates and installs the App, then watches that directory for subsequent builds.
Several Apps may be loaded and watched independently. Penkra validates changed bytes, atomically
replaces the affected sideload, and restores its open App tabs. A partial or invalid rebuild is
rejected and the last working package stays active; fix the build and rebuild again. Penkra does
not restart as part of this loop.

A sideload uses the same manifest validation, permissions, isolation, and runtime as a registry
App, but it is visibly labeled and has no registry listing, rating, install receipt, or automatic
update. IDs and slugs never alias or override an installed registry App; uninstall the collision or
use a separate development identity. The required Apps launcher cannot be uninstalled, so Penkra
Dev atomically replaces its verified registry package when Apps itself is the configured sideload;
this narrow development exception does not apply to any optional App.

Launching Penkra Dev applies migrations and idempotently seeds the local registry Apps using the
development root's persistent signing identity. A published version is immutable: changed bytes
require an explicitly approved version bump. Installing, opening, observing, invoking, packaging,
testing, publishing, and updating are separate operations; evidence for one is not evidence for
another.
