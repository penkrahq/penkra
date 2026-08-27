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
`{ "command": "penkra app --help" }`. The public contract is
`penkra-app.json` plus `@penkra/sdk`. Private Electron, desktop IPC, database, internal development
launchers, and host APIs are not App APIs.

This guide deliberately contains no Penkra product-development, local-service, test-environment,
or release-operations instructions. Those belong to Penkra's contributor documentation and do not
change the App-author contract. There is no public Penkra operation CLI or executable App shim.

Supported Penkra installations expose the public `penkra app ...` author operations in
`penkra --help`. If an older installation does not list them, update Penkra; do not substitute shell
commands or internal product-development procedures.

A Penkra App can have two deliberately separate runtimes: a sandboxed browser UI and an optional
Node operation controller. The UI can use React, Vue, Svelte, Solid, vanilla DOM, or another
browser-compatible stack. The controller uses ordinary Node APIs and dependencies for background
work, while the Penkra SDK supplies Penkra concepts such as operations, tabs, Account data,
settings, and secrets. There is no required scaffold: begin with the files below or copy
`examples/sample-app` when an example is useful.

## Package shape

Every built package directory contains:

```text
my-app/
├── penkra-app.json       Manifest and public capabilities
├── README.md             Human-facing App description
├── INSTRUCTIONS.md       Agent-facing operational guidance for this App
├── app.html              Visual entrypoint
├── operations.js         Optional Node operation controller
├── package.json          Optional standard Node module/dependency metadata
└── assets/               Declared icons and local browser assets
```

Penkra loads the controller with Node's ordinary module rules. Add `{ "type": "module" }` when an
`operations.js` bundle uses ESM syntax, use an `.mjs` entrypoint, or publish CommonJS as `.cjs`.
TypeScript and framework source remain build inputs; point the manifest at emitted JavaScript.

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
  "entrypoints": { "app": "app.html", "operations": "operations.js" },
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
      "instructions": "Use the returned tab ID for visible review. Opening does not change note content.",
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
Penkra presents the operation to an agent as `notes documents open`. Inputs and outputs are
bounded JSON Schemas and are validated at the host boundary. See [Naming operations](#naming-operations)
for how to choose the key itself.

Every operation requires at least one named example whose `input` matches the declared input
schema. Penkra renders examples as complete `penkra_exec_command` calls in generated help and
rejects missing, malformed, or schema-invalid examples during App testing, packaging, sideloading,
and publication. Use optional `instructions` for operation-specific procedure, limits, and recovery;
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

Subject then verb, with everything else passed as named command options. This is the shape agents see
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

The operation controller is not a hidden webpage and cannot inspect the shell or any App tab DOM.
Penkra starts one dedicated Node process for each active App installation and Space, loads the declared
`operations.js`, and exposes the SDK as `globalThis.penkra` and through `@penkra/sdk`. Controller
code may use standard Node facilities such as `node:fs`, `Buffer`, `fetch`, `node:crypto`, streams,
and packaged JavaScript dependencies. The initial controller policy disables child processes,
worker threads, WASI, and native add-ons; use a host SDK service when work genuinely needs a
Penkra-owned native lifecycle, such as Simulator. A controller crash disables that App runtime in
the affected Space and cancels its outstanding operations; it does not compromise a visual tab's
browser boundary.

Controllers receive ordinary OS context such as the home, temporary, locale, and executable-search
paths. Penkra does not inherit its own runtime tokens, provider credentials, `NODE_OPTIONS`, or
unrelated parent-process environment variables into an App controller.

Do not route ordinary controller filesystem or HTTP work through `penkra.files` or
`penkra.network`. Those SDK surfaces exist for sandboxed visual tabs. Use the SDK in a controller
only for capabilities owned by Penkra: operation registration and context, tabs, Account access,
App settings and secrets, identity, and other explicit host services.

The runtime boundary determines the API; whether code belongs to the same App does not:

| Work                                                      | Visual tab (`app.html`)                           | Operation controller (`operations.js`)                      |
| --------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Read or write ordinary host files                         | Use an opaque `files` handle or App `storage`     | Use `node:fs` and normal paths                              |
| Make a small remote request                               | Use mediated `network.fetch` or `account.request` | Use Node `fetch` or a packaged HTTP client                  |
| Move bulk bytes to or from a picked handle or App storage | Use `transfer`                                    | Not available; the controller does not own renderer handles |
| Register and implement a public operation                 | Not available                                     | Use `operations.handle` and `OperationContext`              |
| Address an App-owned tab during an operation              | Handle an incoming tab call                       | Use the tab handle supplied by `OperationContext`           |

`network-fetch` authorizes Penkra's mediated visual-tab network and transfer services. It does not
wrap or technically constrain a controller's ordinary Node networking. App review must therefore
assess the controller source and packaged dependencies as executable Node code, not infer its
authority solely from renderer permission declarations.

App renderers use a restrictive Content Security Policy. An App may fetch only files from its own
verified immutable package origin (`connect-src 'self'`); remote renderer connections remain
blocked. Packaged WebAssembly is supported with `wasm-unsafe-eval`, which permits compiling local
Wasm without permitting JavaScript `eval` or remote code loading. Network and hosted-service work
crosses explicit host capabilities so permissions, destination checks,
attribution, credentials, and revocation stay enforceable. The current special permissions are
`network-fetch`, `browser-session`, `simulator-session`, `account-data`, and `account-identity`.

### Files and directories in visual tabs

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
trusted prerequisite/license prompts. Visual tabs never receive a raw process handle or ambient
project directory; build frameworks continue to target the returned platform identifier normally.

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
Visual tabs never receive ambient filesystem access. A hosted browser session can control only pages
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

An operation executes in one dedicated Node controller for the App and Space. Register handlers
from the controller entrypoint with `operations.handle(...)`; controller source is not loaded into
the visual App. `context.caller.kind` is
host-asserted as `user`, `agent`, `app`, or `host`; caller identity is not exposed.

Most handlers return the declared JSON output directly. When an operation also needs to return
model-visible text or images, return the MCP-compatible rich shape exported as
`AppOperationRichResult`: `content` contains text/image blocks and `structuredContent` contains the
ordinary declared output. The trusted broker validates the media blocks and validates
`structuredContent` against the manifest output schema before anything reaches the caller.

When an invocation includes `tabId`, `context.tab` addresses exactly that validated App tab. Use
`context.tab.invoke` for an in-place UI function and `context.tab.navigate` to change its App route.
Call `context.tab.close()` to close that same validated, App-owned tab; do not retain a handle across
invocations. Resolve the target again from each invocation so ownership and liveness are rechecked.
Without a target, use `context.tabs.open`. Use `ForResult` variants only when an operation genuinely
waits for a person. Cancellation includes tab close, timeout, disable, uninstall, and host shutdown.

Inside the visual App, `tab.setRoute` records App-owned navigation without causing a second
navigation event. Penkra uses that latest recorded route and state when it recreates the tab.

Apps may invoke another installed App's public operation through `context.operations.invoke`; the
callee's schemas and permissions still apply. Apps cannot invoke private installation operations.

## Visual-tab storage, byte movement, and composer staging

The APIs in this section belong to a visual App tab. `storage` is private to one App and Space.
`writeFile`, `list`, `usage`, and `remove` operate only inside that root. Paths supplied to storage
methods are relative. Listed entries retain both their storage-relative key and their host-local
absolute path. Hosted Browser download events likewise provide both forms. The absolute form may be
passed to the App's Node operation controller and opened with ordinary Node filesystem APIs; the
relative form is for visual-tab `storage` calls. The host rejects traversal and symlinks, keeps a
free-disk safety floor, and erases the root when App data is removed.

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

From a visual tab, use `transfer` when bulk bytes cross between an HTTPS endpoint and renderer-owned
bytes, an opaque file handle, or App storage. Every method requires `network-fetch`. The tab names
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

That download travels directly from the remote server through the trusted host into the selected
file. Its bulk bytes do not pass through the renderer or an operation result. Do not insert a Node
controller merely to proxy the same remote response.

Conversely, controller work such as materializing agent inputs uses ordinary Node APIs:

```js
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function downloadAtomically(url, destination) {
  const temporary = `${destination}.partial`;
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
```

Controllers cannot resolve a visual tab's opaque file handle, and operation results are not a
bulk-byte transport. A workflow that generates a large controller-local artifact and then needs a
user-selected destination requires an explicit handoff design; it must not serialize the file into
operation JSON or call renderer-only `files`, `storage`, or `transfer` APIs from the controller.

Transfer progress comes from the host and measures the actual remote upload or download. Native
`XMLHttpRequest.upload.onprogress` does not fire for the local custom-scheme endpoint and would in
any case measure only renderer-to-host handoff. Use the supported subscription:

```js
const stop = transfer.onProgress((event) => {
  progress.value = event.totalBytes ? event.movedBytes / event.totalBytes : null;
});
```

Hosted-page downloads for an App with `browser-session` are redirected into one flat `downloads/`
directory under the App and Space's private storage root. The host sanitizes the suggested name and
adds a numeric suffix when needed, so concurrent downloads cannot overwrite one another. It does
not impose Thread, App-tab, or workflow directories.

Subscribe with `browser.onDownload` in the owning App tab. Each transfer emits `pending`, then
`completed` or `failed`, and includes two names for the same destination:

```js
import { browser, storage } from "@penkra/sdk";

browser.onDownload((event) => {
  // Absolute host path: pass to an operation controller that will use node:fs.
  console.log(event.path);

  // App-storage key: use directly from the visual tab.
  if (event.state === "failed") void storage.remove({ path: event.storagePath });
});
```

The event is delivered only to the App tab that owns the hosted Browser session. The App decides
which run or workflow owns the path, records that association if it must survive a restart, and
removes files when they are no longer needed. Closing a tab does not delete its completed downloads.
Wait for pending transfers before deleting run data or closing a workflow.

An App declaring high-risk `thread-compose` may call `composer.stage` to stage text, titled
documents, App-storage files/images, its own contributed Skills, effort, and an ordered list of model
fallbacks. The host selects the first usable model and returns it. Staging never sends. It is rejected
atomically with `COMPOSER_NOT_EMPTY` when the operator already has visible draft content or queued
turns, so an App cannot silently overwrite work.

`composer.stage` intentionally remains a bounded draft-materialization call rather than a bulk-byte
transport: App-storage attachments are read into the visible composer draft, with a 256 MiB limit per
attachment. Use blob URLs and transfers for playback, previews, uploads, downloads, and other bulk
flows that do not need to become composer attachments.

Agents call the single registered `penkra_exec_command` host tool. Its `command` field is one
ordinary command-line string. Core commands start with `penkra`; App commands start with the
installed App's slug:

```json
{ "command": "penkra --help" }
{ "command": "apps list" }
{ "command": "penkra open --path /absolute/path/to/file" }
{ "command": "notes notes open --id note-123" }
{ "command": "notes notes open --help" }
```

Operation help includes the complete validated input and output JSON Schemas. App commands do not
have a separate schema mode.

These are registered operations, not shell execution. Ordinary quoting and `--name value` parsing
apply, but substitution, expansion, pipes, redirects, and PATH lookup do not. Object and array
values use JSON through `--input`. An agent must establish installed Apps with `apps list`
rather than infer installation from source code or a similarly named tool.

## Agent observation and interaction

Penkra core—not the public SDK—lets the trusted agent harness inspect exact retained App tabs for
accessibility and interaction. Pixel capture is deliberately limited to the App tab currently
visible for the caller Thread:

```json
{ "command": "penkra tabs current" }
{ "command": "penkra tabs list" }
{ "command": "penkra tabs snapshot --tab-id <tab-id>" }
{ "command": "penkra tabs snapshot --tab-id <tab-id> --ref e17 --depth 3 --boxes true" }
{ "command": "penkra tabs snapshot --tab-id <tab-id> --filename artifacts/app-snapshot.md" }
{ "command": "penkra tabs find --tab-id <tab-id> --query '/save|publish/i'" }
{ "command": "penkra tabs screenshot" }
{ "command": "penkra tabs click --tab-id <tab-id> --ref e17 --observe true" }
{ "command": "penkra tabs hover --tab-id <tab-id> --ref e17" }
{ "command": "penkra tabs type --tab-id <tab-id> --ref e18 --text 'Updated copy'" }
{ "command": "penkra tabs press --tab-id <tab-id> --key Enter" }
{ "command": "penkra tabs select --tab-id <tab-id> --ref e19 --value done" }
{ "command": "penkra tabs scroll --tab-id <tab-id> --delta-y 640" }
{ "command": "penkra tabs wait --tab-id <tab-id> --text Saved" }
{ "command": "penkra tabs handle-dialog --tab-id <tab-id> --accept true" }
{ "command": "penkra tabs upload --input '{\"tabId\":\"<tab-id>\",\"ref\":\"e20\",\"paths\":[\"/absolute/app-storage/file.pdf\"]}'" }
```

Take a fresh snapshot before using an element reference. References belong to one exact tab and
the latest observed document; navigation, reload, replacement, or close invalidates them. Snapshot
returns a hierarchical accessibility representation with Playwright-style `e…` references and
redacts protected control values. Scope a large tree with `target` and `depth`; request `boxes` only
when geometry matters. Find searches the same accessibility representation and returns matching
context without introducing a second document-extraction model. Screenshot returns pixels and is
for visual verification, not element targeting. It accepts no `tabId`: the host captures only the
caller Thread's currently visible App rectangle and fails when that Thread has no visible App tab.
This keeps pixel capture aligned with what Electron can render reliably. Supply `filename` to
snapshot or screenshot when the
result should be saved in the caller Thread's working directory instead of returned inline.
Action commands accept `observe: true` to return
the acknowledgement and a fresh post-action snapshot together.
`handle-dialog` resolves a blocking JavaScript alert, confirm, or prompt. `upload` accepts only files
inside the owning App and Space's storage root and assigns them to the referenced file input.

For ordinary Apps the observable document is the App iframe. The host resolves its exact
`WebFrameMain`, executes inside that frame, and crops a visible screenshot to its current shell DOM
bounds. For an App granted `browser-session`, observation follows the composed geometry. No hosted surface means the App
document is observed; a full-frame hosted surface means the page is observed; a partial surface
appears beneath a `document "Hosted page"` boundary in the same hierarchy and uses
the same `e…` reference namespace. Actions route to the frame that issued each reference. The target must belong to the
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
{ "command": "penkra app sideload --directory ./dist" }
{ "command": "penkra app test --directory ./dist" }
{ "command": "penkra app package --directory ./dist --output ./artifacts/my-app.penkra" }
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
visual renderer, requires the tab to reach `ready`, records diagnostics, and removes the profile. It never
uses or changes the active profile, Space, database, or installed Apps. It complements unit,
accessibility, and visual tests.

`package` validates the manifest, schemas, required documents, referenced paths, compatibility,
permissions, entry count, entry size, total expanded size, and executable-content restrictions. It
then creates a deterministic `.penkra` archive and returns evidence including all relevant digests.

## Publish and inspect status

Use the registered App-author commands:

```json
{ "command": "penkra app status" }
{ "command": "penkra app status --app-id <app-id>" }
{ "command": "penkra app publish --directory ./dist --visibility private" }
{ "command": "penkra app publish --directory ./dist --visibility public" }
{ "command": "penkra app access invite --app-id <app-id> --email person@example.com" }
{ "command": "penkra app access list --app-id <app-id>" }
{ "command": "penkra app access revoke --app-id <app-id> --invitation-id <invitation-id>" }
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
This is also the compatibility declaration for SDK runtime methods: an independently versioned App
that requires a newly added method must raise `compatibility.penkra` to the first desktop release
that provides it. Penkra does not add a second runtime-version negotiation layer.
