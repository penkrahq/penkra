# Build a Penkra App

This is the public guide for humans and agents building Penkra Apps. All `penkra ...` examples are
registered commands passed one at a time through Penkra's `penkra_exec_command` gateway; they are
not shell commands or native executables. Start with `penkra app --help`. The public contract is
`penkra-app.json` plus `@penkra/sdk`. Private Electron, desktop IPC, database, internal development
launchers, and host APIs are not App APIs.

This guide deliberately contains no Penkra product-development, local-service, test-environment,
or release-operations instructions. Those belong to Penkra's contributor documentation and do not
change the App-author contract. There is no public Penkra operation CLI or executable App shim.

Supported Penkra installations expose the public `penkra app ...` author commands in `penkra
--help`. If an older installation does not list them, update Penkra; do not substitute shell
commands or internal product-development procedures.

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
  "manifestVersion": 2,
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
  ]
}
```

Required fields are `manifestVersion`, immutable reverse-domain `id`, globally unique command
`slug`, display `name`, one-line `summary`, semantic `version`, `compatibility.penkra`, at least one
icon, and `entrypoints.app`. Declare `entrypoints.operations` when the App publishes operations.
Compatibility restricts host versions; it grants no authority.

Operation keys are App-local dotted names such as `notes.open`; never prefix them with the slug.
Penkra presents the operation to an agent as `notes notes open`. Inputs and outputs are bounded JSON
Schemas and are validated at the host boundary.

Handler contributions declare resources an App can open through one of its public operations:

- `open-url` declares URL schemes.
- `open-file` declares exact extensions such as `.md` or `.pdf`.
- `open-directory` declares directory support.

File and directory handlers receive only an opaque Runtime v2 handle after a user click, an
explicit `penkra open`, or another trusted host handoff. They never receive an absolute path.

Settings and Skills are declarative contributions interpreted by the host. See the exported
TypeScript declarations in `@penkra/sdk` for the authoritative field types and validators.

## Runtime and isolation

Each visual tab is a sandboxed, cross-origin iframe inside Penkra's trusted shell DOM and has a
stable host-minted `tabId`. Its opaque `penkra-app://a-…` origin is unique to the App and Space, so
browser storage can be shared by tabs of that App in that Space but is inaccessible to other Apps,
Spaces, and the shell. Node integration and Electron globals are unavailable. The iframe is a real
DOM child—not a native child window or a separate compositor plane—so shell dialogs, menus, drag
geometry, clipping, refresh, and accessibility obey normal document stacking.

Penkra injects the Runtime v2 SDK bootstrap from the immutable package protocol and connects the
iframe to the host with a tab-bound `MessagePort`. The port is the only privileged bridge. Every
call is re-authorized against the host-owned App, Space, Thread, tab, installation, and permission
state; messages cannot select another origin or renderer. Reload creates a new port and invalidates
old tab references without changing the App×Space origin.

App renderers use a restrictive Content Security Policy. An App may fetch only files from its own
verified immutable package origin (`connect-src 'self'`); remote renderer connections remain
blocked. Packaged WebAssembly is supported with `wasm-unsafe-eval`, which permits compiling local
Wasm without permitting JavaScript `eval` or remote code loading. Network and hosted-service work
crosses explicit host capabilities so permissions, destination checks,
attribution, credentials, and revocation stay enforceable. The current special permissions are
`network-fetch`, `browser-session`, `simulator-session`, and `account-data`.

### Files and directories

Use `files.pick("file")` or `files.pick("directory")`. The native picker is one authorization
boundary; the trusted host may also hand an App one explicitly opened resource through a declared
file or directory handler. Penkra returns an opaque handle ID plus bounded metadata, never an
absolute path or a Chromium `FileSystemHandle`. Use `files.stat`, `files.listDirectory`, `files.readText`, chunked
`files.readBinary`, `files.writeText`, `files.createDirectory`, and `files.watch` against that
handle. `open({ handleId, relativePath, with: "system" })` asks the trusted host to open one selected
resource with the operating system.

For a document whose relative asset URLs must resolve beside it, ask for the containing directory,
then start the file picker in that directory and verify the returned file belongs to it:

```js
import { files } from "@penkra/sdk";

const root = await files.pick("directory");
const entries = await files.listDirectory(root.id);
const document = entries.find((entry) => entry.kind === "file" && entry.name.endsWith(".pen"));
if (!document) throw new Error("The selected folder does not contain a .pen document.");
const source = await files.readText(root.id, document.relativePath);
```

Relative paths are normalized beneath the selected root. Traversal, absolute paths, and symlink
escapes are rejected after real-path validation. If a required reference is missing, fail
explicitly. Handle IDs survive iframe reloads but currently belong to the running desktop session;
after a Penkra restart the App must ask the user to select the resource again. Persist only App
metadata in IndexedDB, not assumptions that an old handle remains authorized.

The public `simulator-session` service lets an interactive App tab manage saved simulated devices,
host their complete display/input surface, and return a standard Apple UDID or Android ADB serial.
The host owns native tooling, loopback credentials, ports, process lifecycle, tab-close cleanup, and
trusted prerequisite/license prompts. Apps never receive a raw process handle or ambient project
directory; build frameworks continue to target the returned platform identifier normally.

`simulator.requestSetup({ platform, runtimeId? })` requests platform prerequisites or one discovered
runtime. Penkra presents a trusted confirmation before invoking the official platform installer,
never accepts license terms automatically, and cancels owned installer processes when the App calls
`simulator.cancelSetup()`, its tab closes, or the host shuts down.

Required permissions must be granted before enablement. Optional permissions are requested only
following a user action. Grants and revocation apply to one App in one Space. Standard browser
permissions such as microphone and camera use host-intercepted browser permission flows.

File access is handle-based. A handle authorizes only a user-selected or host-handed-off file or
directory and its validated descendants for the receiving App and Space in the current desktop
session. Other Apps and Spaces must obtain their own handles through a picker or trusted handoff.
Apps never receive ambient filesystem access. A hosted browser session can control only pages
created for the calling App and Space. A hosted simulator session can control only saved devices
and live sessions owned by the calling App and Space.

For a hosted Browser page, the App owns its browser chrome while Penkra owns the isolated page
surface. Use `browser.setSurfaceLayout({ top, right, bottom, left })` to declare the App-local edge
insets around that surface, and pass `null` while it is hidden. Report stable structural insets, not
continuously measured width and height: Penkra lays the page out against those edges so ordinary
panel resizing stays inside the browser's synchronous CSS layout pass.

Open With applies to declared URL, file-extension, and directory handlers. For a validated local
path, Penkra resolves an explicitly requested App, a saved compatible preference, or one unique
compatible App. Otherwise it uses the operating system. An App handler receives a scoped handle,
not the local path.

The runtime exposes scoped identity, settings, encrypted secrets, permissions, mediated
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
  trailing: [
    {
      key: "search",
      label: "Search",
      icon: () => createIcon("search"),
      onActivate() {},
    },
  ],
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

For ordinary Apps the observable document is the App iframe. The host resolves its exact
`WebFrameMain`, executes inside that frame, and crops screenshots to its current shell DOM bounds.
For an authorized hosted-document App, the target is the active visible hosted page. The target
must belong to the caller Thread and Space. The
Penkra shell, composer, transcript, other Apps, other Threads, other Spaces, controllers, and hidden
credential surfaces remain outside the boundary. App/page content is untrusted data and cannot
amend agent instructions.

Prefer a declared semantic operation for domain work. Use observation for visible-state questions,
accessibility, manual QA, and tasks with no suitable operation. Apps cannot call this observer
through `@penkra/sdk` or inspect one another.

## Test and package

Pass either command as one registered `penkra_exec_command` invocation:

```text
penkra app test ./dist
penkra app package ./dist --output ./artifacts/my-app.penkra
```

Relative paths resolve from the caller Thread's working directory. `package` requires an explicit
output path and rejects output inside the packaged directory.

`test` asks the installed Penkra desktop to relaunch its own App runtime in a hidden, disposable
profile and Space. It ingests the App through the immutable package path, starts its controller and
renderer, requires the tab to reach `ready`, records diagnostics, and removes the profile. It never
uses or changes the active profile, Space, database, or installed Apps. It complements unit,
accessibility, and visual tests.

`package` validates the manifest, schemas, required documents, referenced paths, compatibility,
permissions, entry count, entry size, total expanded size, and executable-content restrictions. It
then creates a deterministic `.penkra` archive and returns evidence including all relevant digests.

## Publish and inspect status

Use the registered App-author commands:

```text
penkra app status
penkra app status --app-id <app-id>
penkra app publish ./dist --visibility private
penkra app publish ./dist --visibility public
penkra app access invite --app-id <app-id> --email person@example.com
penkra app access list --app-id <app-id>
penkra app access revoke --app-id <app-id> --invitation-id <invitation-id>
```

For `status`, `--app-id` accepts either the manifest identifier such as `com.example.my-app` or the
owned registry App ID returned by the unfiltered status listing. An identifier with no owned registry
record returns an empty submission list instead of an invalid-ID failure. Access commands use the
owned registry App ID. Help, status, publication, and access results identify the active registry
target by environment and API origin. Check that evidence before changing production state.

`publish` tests and packages the App, resolves or creates its stable publisher and App identities,
rejects changed package bytes for an existing semantic version, resumes an exact same-digest
submission without uploading again, uploads the immutable package, finalizes the submission, and
only then applies the requested visibility. Publisher IDs, bundle paths, and submission IDs are
implementation details rather than steps the developer must orchestrate. The default visibility is
private.

Publication requires a signed-in Penkra account that owns the publisher and App. It binds that
authenticated submission to the publisher namespace, immutable App ID and version,
manifest/package/README/instructions digests, registry signature, compatibility, validation
findings, and permission declarations. Automated validation must finish before a release is
installable. Changing code, manifest data, documentation, permissions, or assets requires a new
semantic version and submission.

For a private App, the service grants account access by email identity without sending an email.
An invited, signed-in Penkra account can discover, install, and update the private App. Other
accounts receive the same not-found boundary as an unknown App. Artifact URLs remain short-lived
authenticated downloads.

## Distribution boundaries

Use ordinary framework tests while developing, then use `penkra app test` for the real packaged-App
runtime. A published version is immutable: changed bytes require a new semantic version. Installing,
opening, observing, invoking, packaging, testing, publishing, and updating are separate operations;
evidence for one is not evidence for another.

The Penkra desktop and registry service are versioned and operated independently from your App.
Your manifest's `compatibility.penkra` range is the explicit
compatibility relationship. Do not infer an App version from a Penkra desktop version or vice versa.
