# Build a Penkra App

This is the public guide for humans and agents building Penkra [Apps](concepts.md#app). The shared
product model—[Spaces](concepts.md#space), [Threads](concepts.md#thread),
[folders](concepts.md#folder), [operations](concepts.md#operation),
[controllers](concepts.md#controller), [tabs](concepts.md#tab),
[installations](concepts.md#installation), [Skills](concepts.md#skill), and
[sideloads](concepts.md#sideload)—is defined once in the [Penkra concepts](concepts.md) guide.

All `penkra ...` examples are
registered commands passed one at a time through Penkra's `penkra_exec_command` gateway; they are
not shell commands or native executables. Start with
`{ "command": ["penkra", "app", "--help"] }`. The public contract is
`penkra-app.json` plus `@penkra/sdk`. Private Electron, desktop IPC, database, internal development
launchers, and host APIs are not App APIs.

This guide deliberately contains no Penkra product-development, local-service, test-environment,
or release-operations instructions. Those belong to Penkra's contributor documentation and do not
change the App-author contract. There is no public Penkra operation CLI or executable App shim.

Supported Penkra installations expose the public `penkra app ...` author operations in
`["penkra", "--help"]`. If an older installation does not list them, update Penkra; do not substitute shell
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
      "key": "documents.open",
      "summary": "Open one exact note in an App tab and return its tab ID.",
      "guidance": "Use the returned tab ID for visible review. Opening does not change note content.",
      "input": {
        "type": "object",
        "properties": { "id": { "type": "string" } },
        "required": ["id"],
        "additionalProperties": false
      },
      "output": { "type": "object" },
      "examples": [
        {
          "name": "Open a project note",
          "input": { "id": "note_01HXYZ" }
        }
      ],
      "handler": "documents.open"
    }
  ]
}
```

Required fields are `manifestVersion`, immutable reverse-domain `id`, globally unique command
`slug`, display `name`, one-line `summary`, semantic `version`, `compatibility.penkra`, at least one
icon, and `entrypoints.app`. Declare `entrypoints.operations` when the App publishes operations.
Compatibility restricts host versions; it grants no authority.

Operation keys are App-local dotted names such as `documents.open`; never prefix them with the slug.
Penkra presents the operation to an agent as `["notes", "documents", "open"]`. Inputs and outputs are
bounded JSON Schemas and are validated at the host boundary. See [Naming operations](#naming-operations)
for how to choose the key itself.

Every operation requires at least one named example whose `input` matches the declared input
schema. Penkra renders examples as complete `penkra_exec_command` calls in generated help and
rejects missing, malformed, or schema-invalid examples during App testing, packaging, sideloading,
and publication. Use optional `guidance` for operation-specific procedure, limits, and recovery;
keep the summary concise enough for discovery.

Handler contributions declare resources an App can open through one of its public operations:

- `open-url` declares URL schemes.
- `open-file` declares exact extensions such as `.md` or `.pdf`.
- `open-directory` declares directory support.

File and directory handlers receive only an opaque Runtime v2 handle after a user click, an
explicit `penkra open`, or another trusted host handoff. They never receive an absolute path.

Settings and Skills are declarative contributions interpreted by the host. See the exported
TypeScript declarations in `@penkra/sdk` for the authoritative field types and validators.

## Naming operations

Nothing below is validated. `penkra app test` will not reject a name for any reason in this section,
because a naming rule strict enough to enforce would reject reasonable designs the platform has not
seen yet. Treat this as the reasoning behind the names Penkra itself uses, so your App reads like
part of the same system.

An operation key becomes words an agent types. Write the key for the thing that changes, then name
the change:

```
documents.create        canvas documents create
documents.publish       canvas documents publish
issues.assign           linear issues assign
```

Subject then verb, with everything else passed as `input` or `flags`. This is the shape agents see
everywhere else on the surface — `penkra threads list`, `penkra tabs snapshot` — so an operation
written this way needs no explanation.

### Do not repeat the slug

The slug is already the first word of every command. An App with slug `notes` declaring `notes.open`
produces `notes notes open`, which reads like a mistake and makes an agent wonder whether it has
mis-assembled the command. Name the key for the entity inside your App, not for your App:

| Slug    | Key              | Agent types            |                 |
| ------- | ---------------- | ---------------------- | --------------- |
| `notes` | `notes.open`     | `notes notes open`     | stutters        |
| `notes` | `documents.open` | `notes documents open` | reads correctly |

If your App has exactly one kind of thing and the repetition seems unavoidable, that is a signal the
key should be the bare verb: `notes open`.

### When a nested segment is earned

A middle segment is worth its word only when the child it names cannot be addressed without its
parent. The test is whether an identifier alone is enough to find the thing.

`documents.comments.add` can be earned. If a comment ID is meaningless on its own and every lookup
needs the document that contains it, the nesting reflects how the data actually works, and an agent
reading the name learns something true: it will need a document in hand.

`documents.meta.update` is not earned. `meta` is not an entity in your App — there is no meta record,
no meta ID, nothing to address. It is a label for fields the author decided were unimportant, and
labels like that drift: the next field that seems unimportant lands there too, until the command
updates several unrelated things and its name still says `meta`. Call it `documents.update`.

`documents.list-for-space` is not earned either, for a related reason. It names a view rather than a
resource. There is no collection stored anywhere that this addresses; there is a filter, and filters
belong in `input`.

Penkra's own surface has exactly one nested family — `penkra app access invite`, `list`, and
`revoke` — and it qualifies on this test. An invitation exists only against a specific App, carries
no meaning apart from it, and cannot be resolved from its own ID.

### Why this matters at the call site

An agent picks an operation from a list of names, usually before reading any help. The name is the
only thing it has when deciding whether your operation is the one the user meant.

Consider a user who says "share the Q3 doc with Priya." An agent scanning `documents.share`,
`documents.access.invite`, and `documents.meta.update` can rule the third out immediately and has a
real question about the first two — which is a good question, answerable by reading their summaries.
Now give the same agent `documents.update`, `documents.meta.update`, and `documents.settings.update`
and it has no way to choose except by trying one. The cost of a vague name is not confusion; it is a
write to the wrong place.

Write the `summary` for each operation to answer the question the name raises. In one or two compact
sentences, say what object it acts on and what result it returns or commits, when to choose it over
its nearest neighboring operation, and any prerequisite the caller must already hold such as an
exact ID, scoped handle, target tab, permission, or confirmation. Name a consequential or common
failure when that changes the safe next action. Say when not to use a broad or destructive operation
if its name alone leaves that ambiguous. Avoid store-listing language, implementation detail, and
promises the operation cannot verify.

Audit resource lifecycles as a set. If an App lets an agent create durable or leased state, either
provide the matching close, release, archive, or delete operation or document why that lifecycle is
owned by the visible UI or trusted host instead. A create-only agent surface strands state and makes
cleanup depend on an unrelated interface.

## Agent-facing instructions

Every App ships a nonempty root `INSTRUCTIONS.md`. If the App declares operations, packaging
requires these five second-level sections in this order:

1. `## What this App is` — what it operates on and where that data lives.
2. `## Before you write anything` — required reads, permissions, versions, and other preconditions,
   including what can break when they are skipped.
3. `## How to do the common thing` — one complete worked flow using structured command input.
4. `## Reference` — App-specific semantics that supplement the generated operation contracts.
5. `## When things fail` — recognizable symptoms, likely causes, and safe recovery.

`<slug> --help` combines this document with the operation list generated from the manifest; do not
hand-copy that list into the prose. Operation-specific help renders the complete validated input and
output schemas. Content loaded together belongs in this one document rather than in secondary
guideline operations.

The manifest's App `summary` appears in Penkra's live capability catalog, and each operation
`summary` appears in generated help. Write both as concrete agent-facing descriptions: name the
object acted on and the result, avoid store-listing slogans, and do not promise behavior the
operation cannot verify.

## Agent Skills

An App contributes an Agent Skill by placing an Agent Skills-compatible `SKILL.md` under a
package-relative directory and declaring that directory in `contributions.skills`:

```json
{
  "contributions": {
    "skills": [{ "path": "skills/create-issue" }]
  }
}
```

`penkra app package` requires the exact referenced `skills/create-issue/SKILL.md` to exist inside
the package; missing, duplicate, absolute, or escaping paths are rejected. Keep each Skill focused
on a procedure for this App: the operations to call, their order, and the checks between them. A
Skill cannot grant permissions or prove another capability is installed.

Contributed Skills are enabled by default with their App in one Space. The user can disable an
individual Skill for that App and Space; the host stores this per-Space override. At load time
Penkra attributes the Skill to `app:<slug>` and rejects paths that escape the immutable package, so
one App cannot contribute a Skill on another App's behalf. See [Skill](concepts.md#skill) for the
agent-facing trust model; this section defines only the authoring and packaging contract.

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
`network-fetch`, `browser-session`, `simulator-session`, `account-data`, and `account-identity`.

### Files and directories

Use `files.pick("file")`, `files.pick("directory")`, or `files.pick("save", { suggestedName })`.
The native picker is one authorization boundary; the trusted host may also hand an App one
explicitly opened resource through a declared file or directory handler. Penkra returns an opaque
handle ID plus bounded metadata, never an absolute path or a Chromium `FileSystemHandle`. A save
handle is writable even when its selected leaf does not exist yet. Use `files.stat`,
`files.listDirectory`,
`files.readText`, chunked `files.readBinary`, `files.writeText`, atomic chunked writes with
`files.beginWrite` / `files.writeChunk` / `files.commitWrite`, `files.createDirectory`, and
`files.watch` against that
handle. `open({ handleId, relativePath, with: "system" })` asks the trusted host to open one selected
resource with the operating system.

Do not substitute `window.showOpenFilePicker()` or `window.showSaveFilePicker()`. Apps run in a
cross-origin child frame, and Chromium rejects File System Access API pickers from that frame with
a `SecurityError`. The host `files.pick` methods are the supported user-selection boundary.

`readText` and `writeText` are convenience methods for text up to 16 MB. For larger files, read
successive binary chunks and decode them with a streaming `TextDecoder`. To write a larger file,
begin a write with its expected byte count (and optionally its SHA-256), send the returned maximum
chunk size in order, then commit. Penkra writes to a temporary sibling and replaces the destination
only after the size and checksum are valid. Abort the write on an App-side failure; Penkra also
cleans unfinished writes when their tab, handle, or App scope closes.

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
the calling registry App. A Space ID is isolation context an App may use, not a claim that App data
is automatically owned by the Space or shared with anyone else.

For a backend outside Penkra's Account-data namespace, declare the high-risk `account-identity`
permission with one lowercase DNS audience:

```json
{
  "name": "account-identity",
  "required": true,
  "reason": "Sign you in to Borge.",
  "audience": "api.borge.ai"
}
```

After the grant, `identity.getToken({ audience: "api.borge.ai" })` returns a five-minute EdDSA JWT
and its expiry. The host requires the requested audience to exactly match the reviewed manifest,
keeps the Penkra Account cookie out of the renderer, and stops issuing tokens when the App loses
access or its permission is revoked. The JWT contains the App ID, opaque Space ID, a verified email,
and an audience-pairwise subject: two Apps using the same backend audience see the same subject,
but another audience cannot correlate it. Backends must verify the signature through Penkra's JWKS,
the exact issuer and audience, expiry, App ID, and `email_verified: true`. See
[`app-account-identity.md`](./app-account-identity.md) for the verifier and key-rotation contract.

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
tab.onVisibilityChange(({ active }) => {
  if (active) resumeVisualWork();
  else pauseVisualWork();
});

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
Call `context.tab.close()` to close that same validated, App-owned tab; do not retain a handle across
invocations. Resolve the target again from each invocation so ownership and liveness are rechecked.
Without a target, use `context.tabs.open`. Use `ForResult` variants only when an operation genuinely
waits for a person. Cancellation includes tab close, timeout, disable, uninstall, and host shutdown.

Inside the visual App, `tab.setRoute` records App-owned navigation without causing a second
navigation event. Penkra uses that latest recorded route and state when it recreates the tab.

Apps may invoke another enabled App's public operation through `context.operations.invoke`; the
callee's schemas and permissions still apply. Apps cannot invoke private installation operations.

## App storage, byte movement, and composer staging

`storage` is private to one App and Space. `writeFile`, `list`, `usage`, and `remove` operate only
inside that root. Paths supplied to storage methods are relative; listed entries retain their
host-local absolute path for composer staging and other host-mediated operations. The host rejects
traversal and symlinks, keeps a free-disk safety floor, and erases the root when App data is removed.

Bulk bytes use same-origin URLs instead of renderer RPC. `files.open(handleId, relativePath?)` and
`storage.open(path)` return an unguessable `penkra-app://…/.penkra/blob/…` URL. Use that URL with
ordinary browser APIs such as `fetch`, `<img src>`, `<audio src>`, or `<video src>`. The host serves
the authorized file as a ranged response, so media can stream and seek without loading the whole
file or moving its bytes across the privileged bridge. The 1 MiB limit still applies to renderer
RPC; it is no longer the bulk-byte path.

```js
import { files, storage } from "@penkra/sdk";

const picked = await files.pick("file");
if (picked) {
  const url = await files.open(picked.id);
  video.src = url;
  // Later, once no element or request uses it:
  await files.closeUrl(url);
}

image.src = await storage.open("thumbs/cover.png");
```

An opened URL remains valid until its creating tab closes, its handle is revoked, or the App calls
the matching `files.closeUrl(url)` or `storage.closeUrl(url)`. Treat it like a browser object URL:
do not persist it, share it with another App, or close it while an element or request is still using
it.

Use `transfer` when bytes cross the network. Every method requires `network-fetch`. The App names
the HTTPS destination through `transfer.begin`, `transfer.send`, or `transfer.receive`; the host
validates and pins that destination before moving bytes. A renderer cannot turn an arbitrary local
URL into a network target.

Upload bytes generated in the renderer without routing them through RPC:

```js
import { transfer } from "@penkra/sdk";

const { endpoint } = await transfer.begin({
  url: "https://api.example.com/v1/documents",
  method: "POST",
  headers: { "content-type": "application/json" },
});
const response = await fetch(endpoint, { method: "POST", body: documentBlob });
```

Upload a picked or stored file without giving its bulk bytes to the renderer:

```js
await transfer.send({
  url: "https://api.example.com/v1/uploads",
  method: "POST",
  from: { handleId: picked.id }, // or { storage: "exports/archive.zip" }
  field: "file", // omit for a raw request body
});
```

Download atomically to App storage or to a user-selected save location:

```js
const target = await files.pick("save", { suggestedName: "export.pen" });
if (target) {
  await transfer.receive({
    url: "https://api.example.com/v1/export",
    to: { handleId: target.id }, // or { storage: "exports/export.pen" }
  });
}
```

Transfer progress comes from the host and measures the actual remote upload or download. Native
`XMLHttpRequest.upload.onprogress` does not fire for the local custom-scheme endpoint and would in
any case measure only renderer-to-host handoff. Use the supported subscription:

```js
const stop = transfer.onProgress((event) => {
  progress.value = event.totalBytes ? event.movedBytes / event.totalBytes : null;
});
```

Hosted-page downloads for an App with `browser-session` are redirected into
`downloads/<tab-id>/` under its storage root. Subscribe with `browser.onDownload`; each transfer
emits `pending` followed by `completed` or `failed`, with a sanitized collision-free destination.
Wait for pending transfers before deleting run data or closing a workflow.

An App declaring high-risk `thread-compose` may call `composer.stage` to stage text, titled
documents, App-storage files/images, its own contributed Skills, effort, and an ordered list of model
fallbacks. The host selects the first usable model and returns it. Staging never sends. It is rejected
atomically with `COMPOSER_NOT_EMPTY` when the operator already has visible draft content or queued
turns, so an App cannot silently overwrite work.

Agents call the single registered `penkra_exec_command` host tool. Its `command` field is an array
of exact words, not a shell string. Structured operation data goes in `input`; short named scalar
options may go in `flags`; `tabId` is a separate field. Core commands start with `penkra`; App
commands start with the enabled App's slug:

```json
{ "command": ["penkra", "--help"] }
{ "command": ["penkra", "apps", "list"] }
{ "command": ["penkra", "open"], "flags": { "path": "/absolute/path/to/file" } }
{ "command": ["notes", "notes", "open"], "input": { "id": "note-123" } }
{ "command": ["notes", "notes", "open", "--help"] }
```

Operation help includes the complete validated input and output JSON Schemas. App commands do not
have a separate schema mode.

These are registered operations, not shell strings. There is no quoting, escaping, substitution,
or JSON-inside-JSON serialization. An agent must establish enabled Apps with
`["penkra", "apps", "list"]` rather than infer installation from source code or a similarly named
tool.

## Agent observation and interaction

Penkra core—not the public SDK—lets the trusted agent harness inspect visible App tabs for visual
state, accessibility, and manual QA:

```json
{ "command": ["penkra", "tabs", "current"] }
{ "command": ["penkra", "tabs", "list"] }
{ "command": ["penkra", "tabs", "snapshot"], "tabId": "<tab-id>", "flags": { "expand": true } }
{ "command": ["penkra", "tabs", "extract"], "tabId": "<tab-id>" }
{ "command": ["penkra", "tabs", "screenshot"], "tabId": "<tab-id>" }
{ "command": ["penkra", "tabs", "click"], "tabId": "<tab-id>", "flags": { "ref": "a17", "observe": true } }
{ "command": ["penkra", "tabs", "hover"], "tabId": "<tab-id>", "flags": { "ref": "a17" } }
{ "command": ["penkra", "tabs", "type"], "tabId": "<tab-id>", "flags": { "ref": "a18", "text": "Updated copy" } }
{ "command": ["penkra", "tabs", "press"], "tabId": "<tab-id>", "flags": { "key": "Enter" } }
{ "command": ["penkra", "tabs", "select"], "tabId": "<tab-id>", "flags": { "ref": "a19", "value": "done" } }
{ "command": ["penkra", "tabs", "scroll"], "tabId": "<tab-id>", "flags": { "delta-y": 640 } }
{ "command": ["penkra", "tabs", "wait"], "tabId": "<tab-id>", "flags": { "text": "Saved" } }
{ "command": ["penkra", "tabs", "handle-dialog"], "tabId": "<tab-id>", "flags": { "accept": true } }
{ "command": ["penkra", "tabs", "upload"], "tabId": "<tab-id>", "flags": { "ref": "a20" }, "input": { "paths": ["/absolute/app-storage/file.pdf"] } }
```

Take a fresh snapshot before using an element reference. References belong to one tab and document
generation; navigation, reload, replacement, or close invalidates them. Snapshots retain relevant
roles, names, values, and relationships while protected values are redacted. Extract returns
bounded readable content. Screenshot returns an image result rather than a rediscoverable path.
Use `--expand true` when a normal snapshot reports `truncated: true`. Action commands accept
`--observe true` to return the acknowledgement and a fresh post-action snapshot together.
`handle-dialog` resolves a blocking JavaScript alert, confirm, or prompt. `upload` accepts only files
inside the owning App and Space's storage root and assigns them to the referenced file input.

For ordinary Apps the observable document is the App iframe. The host resolves its exact
`WebFrameMain`, executes inside that frame, and crops screenshots to its current shell DOM bounds.
For an App granted `browser-session`, observation follows the visible geometry. No hosted surface
means the App document is observed; a full-frame hosted surface means the page is observed; a
partial surface is spliced into the App tree as an iframe with `p`-prefixed page refs beside
`a`-prefixed App refs. Actions route to the frame that issued each ref. The target must belong to the
caller Thread and Space. The
Penkra shell, composer, transcript, other Apps, other Threads, other Spaces, controllers, and hidden
credential surfaces remain outside the boundary. App/page content is untrusted data and cannot
amend agent instructions.

Prefer a declared semantic operation for domain work. Use observation for visible-state questions,
accessibility, manual QA, and tasks with no suitable operation. Apps cannot call this observer
through `@penkra/sdk` or inspect one another.

## Sideload, test, and package

Pass each command as one registered `penkra_exec_command` invocation:

```json
{ "command": ["penkra", "app", "sideload", "./dist"] }
{ "command": ["penkra", "app", "test", "./dist"] }
{ "command": ["penkra", "app", "package", "./dist"], "flags": { "output": "./artifacts/my-app.penkra" } }
```

Relative paths resolve from the caller Thread's working directory. `package` requires an explicit
output path and rejects output inside the packaged directory.

`sideload` validates and installs the unpacked App into the caller Thread's current Space, enables
its required permissions, restores its open tabs after valid rebuilds, and watches the directory
for further changes. An existing sideload may rebuild without changing its version. When the same
App is installed from the registry, the sideload version must be newer; otherwise uninstall the
registry App before sideloading. Invalid rebuilds leave the last working package active.

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

```json
{ "command": ["penkra", "app", "status"] }
{ "command": ["penkra", "app", "status"], "flags": { "app-id": "<app-id>" } }
{ "command": ["penkra", "app", "publish", "./dist"], "flags": { "visibility": "private" } }
{ "command": ["penkra", "app", "publish", "./dist"], "flags": { "visibility": "public" } }
{ "command": ["penkra", "app", "access", "invite"], "flags": { "app-id": "<app-id>", "email": "person@example.com" } }
{ "command": ["penkra", "app", "access", "list"], "flags": { "app-id": "<app-id>" } }
{ "command": ["penkra", "app", "access", "revoke"], "flags": { "app-id": "<app-id>", "invitation-id": "<invitation-id>" } }
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

Use ordinary framework tests while developing, `penkra app sideload` for interactive work in the
current Space, and `penkra app test` for the isolated packaged-App runtime. A published version is
immutable: changed bytes require a new semantic version. Installing, sideloading, opening,
observing, invoking, packaging, testing, publishing, and updating are separate operations; evidence
for one is not evidence for another.

The Penkra desktop and registry service are versioned and operated independently from your App.
Your manifest's `compatibility.penkra` range is the explicit
compatibility relationship. Do not infer an App version from a Penkra desktop version or vice versa.
