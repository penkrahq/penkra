# App runtime security contract

This document defines the trust boundaries and enforceable invariants for installable Penkra Apps.
It is an implementation contract, not a second product plan. Product scope and sequencing remain in
the workspace-root `TODO.md`.

## Trust boundaries

| Principal                                    | Trust              | Authority                                                                                      |
| -------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| Penkra main process                          | Trusted            | Package verification, App lifecycle, sessions, permissions, tab routing, privileged operations |
| Apps installation binding                    | Trusted and narrow | Verified package mutation only; unavailable to ordinary Apps                                   |
| App controller                               | Untrusted          | Declared operation handlers for one App in one Space                                           |
| App tab renderer                             | Untrusted          | Visual UI for one App in one Space and one Penkra thread                                       |
| Registry/package/README/INSTRUCTIONS content | Untrusted input    | Data only until separately verified, sanitized, and authorized                                 |
| Another App, agent, or CLI caller            | Untrusted caller   | Only declared operation input and explicit host context                                        |

First-party App packages receive the same sandbox and permission checks as third-party packages.
`com.penkra.apps` is not generally privileged; only its trusted host-owned installation binding is.

## Identity and isolation invariants

- Manifest `id` is immutable package identity. Manifest `slug` is the globally unique human and
  agent command root. App-local operation keys never repeat the slug.
- Executable packages are registered once per local desktop profile. Enablement, permissions,
  settings, storage, controller, and session authority are scoped to one App and one Space.
- Each App/Space pair receives a deterministic persistent Electron partition derived from both
  identities. Apps cannot choose, enumerate, or attach to partitions.
- Each App tab receives a host-minted stable `tabId` and is bound to one App ID, Space ID, and
  Penkra thread ID. A caller-supplied `tabId` is validated against all three before delivery.
- App renderers and controllers run with sandboxing and context isolation enabled and Node,
  `<webview>`, insecure content, and direct filesystem access disabled.
- App package documents load only from their assigned `penkra-app://<app-id>` origin. Top-level
  navigation to another origin is denied. External links use a separate mediated host action.
- Package-path resolution percent-decodes once, rejects invalid encoding and NUL bytes, and proves
  the resolved path remains under the verified immutable package root.
- Package ingestion rejects symbolic links and other filesystem indirections; lexical containment
  alone is not treated as proof that a file belongs to the package.

## Messaging and operations

- The trusted host owns the transport. App code receives an allowlisted preload API, never raw IPC.
- Every bridge message has a schema, direction, sender identity, and bounded payload. Renderer input
  is untrusted even after transport validation.
- The operation address is structured as `{ app, operation }`; `tabId` is an optional invocation
  envelope field and never part of the App's declared input schema.
- One controller exists per App/Space. Calls to a tab are point-to-point. Penkra does not broadcast
  operation requests and does not guess a document from focus or active UI.
- A target tab is captured at invocation start. Later focus, navigation, or tab selection cannot
  retarget that invocation.
- App-owned collaboration or cross-tab synchronization is App data behavior and remains separate
  from Penkra operation routing.
- App handlers receive declared input separately from host-owned invocation context. They cannot
  forge invocation identity, App identity, Space identity, thread identity, or permission grants.
- In-flight work observes an abort signal. Disable, uninstall, tab close, timeout, user cancellation,
  and host shutdown terminate work with a canonical cancellation reason.

## Agent-observed content

App and hosted-page text remains untrusted after Penkra validates, bounds, redacts, and returns an
observation. The runtime enforces where an agent may observe and act: the exact tab must belong to
the caller's Thread and Space, references expire with the observed document generation, protected
values are redacted, and every later operation still crosses its own schema, capability, permission,
and authorization boundary. App content cannot call agent tools or grant itself authority.

Penkra does not attempt to classify arbitrary natural-language content as benign text or prompt
injection. Such a classifier could neither prove intent nor safely remove instructions without also
destroying legitimate document content. The semantic rule that observed content supplies data but
never authority is therefore instruction-enforced, not runtime-enforced. This is an accepted risk:
the shared agent policy carries the semantic distinction, while runtime isolation and per-effect
authorization limit what a mistaken interpretation can reach. Any future control must preserve the
content needed for the user's task and must be evaluated as defense in depth, not as a replacement
for effect-level authorization.

### App-authored catalog metadata

An App manifest's `summary` is validated only as a non-empty UTF-8 JSON string. Penkra deliberately
does not attempt to classify its wording or reject Markdown and imperative language. The live MCP
server manual therefore labels installed-App catalog entries as App-authored, untrusted data and
renders each summary as a JSON-quoted single line. Newlines and Unicode line separators cannot
escape that attributed line or create instruction-document structure.

This is an instruction-enforced boundary, not proof that arbitrary natural language is harmless.
Apps must keep summaries descriptive and user-facing, while the host policy tells the agent that
catalog metadata supplies data rather than authority. Runtime authorization remains the boundary
for every effect even if a model misinterprets a malicious summary.

## Installation and persistence

- Package bytes are immutable after verification. Activation requires valid manifest, identity,
  compatibility, digest, signature/policy, and approved required permissions.
- Installation and update use write-and-sync staging followed by an atomic commit. A failed update
  leaves the prior verified version active.
- Corrupt local registry state is reported and preserved for recovery; it is never silently replaced
  by an empty library.
- Uninstall removes executable registration and package material but retains App data by default.
  Erasing retained data is a separate explicit operation.
- Registry install receipts are backend adoption facts, not the source of truth for local installed
  state. Updates, reinstalls, additional devices, and sideloads do not create new install counts.

## Navigation and network policy

- `penkra-app:` is the only top-level App document protocol. `file:`, `data:`, arbitrary `blob:`,
  `javascript:`, and remote HTTP(S) documents do not become App UI origins.
- Window creation is denied by default. New App tabs are created through `context.tabs.open()` or
  an equivalent user action mediated by the host.
- Remote access is performed through the declared `network-fetch` permission and mediated API.
  Renderer navigation is not a substitute for network permission.
- Bulk transfer destinations are host-named, HTTPS-only, and resolved through the same public-address
  checks as mediated fetches. Renderer-supplied request bodies may stream through a single-use
  same-origin ticket only after the host validates and pins the remote destination. Tickets expire,
  cannot be replayed, and are released with their owning tab or renderer. This prevents an App from
  using a same-origin request as an SSRF path to local or private services.
- Downloads, external-protocol links, clipboard, microphone, camera, notifications, hosted browser
  pages, and simulated devices each require their dedicated host policy. No generic escape hatch
  exists, and Apps have no raw-socket or process-spawn API.

## Local byte URLs

- Blob URL tokens contain at least 256 bits of randomness and disclose no filesystem path. A token
  is registered only after the host resolves an existing regular file through an App-scoped handle
  or the calling App and Space's private storage root.
- Lookup is bound to the exact `penkra-app:` origin and therefore to one App and Space partition.
  Presenting a token from another origin fails closed even if the token value is known.
- The registry owns the canonical resolved path. Serving rejects a path that later resolves through
  a different filesystem object, and responses support only GET/HEAD with single byte ranges.
- A URL is released explicitly, when its source handle is revoked, when its owning tab or renderer
  closes, when the App/Space runtime deactivates, or when the host shuts down. URL lifetime does not
  extend the underlying file-handle or App-storage authority.
- Blob responses retain the App CSP and no-sniff policy. They do not create a second scheme,
  renderer permission, ambient filesystem capability, or cross-App byte channel.

## Required failure behavior

- Missing, disabled, uninstalled, incompatible, or revoked Apps fail closed with attributable errors.
- A renderer or controller crash does not crash the shell. Repeated crashes trigger a safe-disable
  path while preserving recoverable data.
- Startup offers a safe mode that skips optional App activation without resetting Appearance or
  deleting App data.
- Unknown bridge methods, operations, permissions, protocols, routes outside the package, and tab
  ownership mismatches are denied rather than inferred.

## Verification gates

Before ordinary App packages can run, tests must demonstrate cross-App and cross-Space partition
separation, package traversal rejection, navigation/window denial, Node isolation, exact-tab routing,
permission revocation races, cancellation, crash containment, atomic update rollback, and safe start.
