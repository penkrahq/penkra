# Provider Connections Research

Status: research in progress. This document records evidence; it is not an approved architecture or implementation plan.

## Approved product constraints (2026-08-03)

- Remove Sidechats as a clean cut. Do not preserve a compatibility path or convert old Sidechats into a new feature. Verify this installation before migration; if records exist, they may be discarded as explicitly authorized by the operator.
- Remove Penkra's cross-provider `Handoff to <provider>` feature and its transcript-reconstruction behavior.
- Keep native session import and provider-native fork as distinct features. An unsupported native operation must be unavailable rather than emulated with visible-transcript replay.
- The first connection release supports Codex, Claude Code, and OpenCode. The core architecture must remain provider-neutral: support for another provider is added through an adapter, manifest, and conformance tests—not provider-name branches or inferred filesystem behavior in shared orchestration code.
- A Connection has one immutable provider. A started thread has one immutable provider. The draft composer may choose a provider before the first turn, but changing a started thread's Connection is restricted to another Connection for that same provider.
- Provider installations are Penkra-managed by default. Runtime launch, version checks, staged updates, activation, rollback, and QA must all bind to the same absolute managed installation identity; new users must not need a global CLI installation.
- Do not begin Pencil or implementation work until the remaining research and architecture are reviewed by the operator.

One approved intent is now constrained by newly verified provider policy: multiple Connections remain required, but the authentication methods offered for each provider must be officially permitted for a third-party host application. In particular, Claude subscription OAuth cannot currently be offered as a Penkra-managed sign-in flow without Anthropic permission; see the Claude policy finding below.

## Rules for this investigation

- Prefer stable provider-native session operations over reconstructed prompts.
- Separate credential isolation, configuration isolation, process isolation, and conversation-state portability. They are not interchangeable.
- Mark every finding as documented, observed, inferred, or unresolved.
- Do not treat a visible Penkra transcript as equivalent to provider-visible context.
- Do not silently truncate, summarize, replay, or discard context.
- Do not begin Pencil or implementation work until this research is reviewed.

## Local versions observed on 2026-08-03

| Runtime     | Command-reported version                                                         | Notes                                                                                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `codex-cli 0.146.0`                                                              | Installed at `/opt/homebrew/bin/codex` during the initial probe.                                                                                                                                                          |
| Claude Code | `2.1.220`                                                                        | Installed at `~/.local/bin/claude`.                                                                                                                                                                                       |
| OpenCode    | `1.18.5` through `/usr/local/bin`; `1.18.10` through the active NVM installation | Two installations are present. Penkra's launch environment and the interactive shell can resolve different executables, so every runtime record and update action must identify the absolute executable it actually used. |

## Existing Penkra transcript bootstrap

### Observed in source

`apps/server/src/orchestration/handoff.ts` constructs a plain-text context prompt from Penkra's projected user and assistant messages. It:

- retains six messages as the recent section;
- truncates each recent message to 2,400 characters;
- truncates each earlier message to 320 characters;
- drops older entries when the remaining character budget is exhausted;
- caps the complete bootstrap at 32,000 characters;
- does not reproduce the complete provider-native item stream.

The reactor currently uses this mechanism for multiple unrelated cases:

- imported provider handoffs;
- non-native fork/Sidechat context;
- fresh OpenCode or Kilo runtime sessions when no Penkra in-memory session existed before startup;
- providers that rebuild context after restart-based rollback or model changes;
- Claude after a stale native resume fails again following one native retry.

### Git history

The generic prior-transcript path originated in commit `6f39d2a8` (`Fix Kilo and OpenCode transcript handling`). Claude stale-resume recovery was later added in `bd30706a` (`Stabilize provider startup and stale Claude resumes`). The history explains why the mechanism accumulated; it does not prove lossless behavior.

### Unresolved correctness concern

OpenCode and Kilo receive a persisted native session ID in the adapter, but the reactor independently injects Penkra transcript context whenever there was no active in-memory session before `ensureSessionForThread`. This may duplicate context after a successful native resume. It needs an instrumented restart test.

## Provider evidence

### Codex

Documented:

- App Server exposes native `thread/resume`, `thread/fork`, and `thread/compact/start`.
- Thread items include user input, agent output, reasoning, shell commands, file edits, and other model-relevant items.
- `CODEX_HOME` owns configuration, credentials, sessions, history, logs, and other state.
- Separate `CODEX_HOME` values are intentionally separate authentication environments.
- App Server exposes account login/read/logout and rate-limit operations.
- `thread/resume` accepts history or a rollout path only behind experimental protocol fields in current upstream protocol definitions.
- Codex's standalone installer downloads official versioned artifacts from `releases.openai.com/codex` with a GitHub Releases fallback. Official GitHub releases also publish platform archives, a `codex-package_SHA256SUMS` asset, and per-asset SHA256 digests in release metadata.
- The Codex repository and CLI are Apache-2.0 licensed.

Unresolved:

- Whether a stored rollout can be resumed under another independently authenticated `CODEX_HOME` through a stable supported operation.
- Whether experimental history/path resume preserves every compaction, tool, reasoning, goal, approval, and instruction-state semantic needed by Penkra.
- Whether host-managed ChatGPT tokens can safely provide per-process accounts without mutating shared credential state.
- Concurrency guarantees if multiple app-server processes reference shared session state.

Observed in an isolated no-model-call test:

1. Profile A started a thread in an empty `CODEX_HOME` and appended a raw Responses API user item with `thread/inject_items`.
2. A fresh profile C could not resume that thread by ID: App Server returned `no rollout found for thread id ...`.
3. A fresh profile B resumed the original rollout successfully when given its absolute JSONL path. The returned thread retained the original thread ID and referenced the original rollout.
4. The generated 0.146.0 protocol labels path resume `[UNSTABLE]`; history resume is even more restrictive: `[UNSTABLE] FOR CODEX CLOUD - DO NOT USE`.
5. No authenticated model turn was sent. The empty profiles produced an expected unauthorized websocket diagnostic after thread startup/resume.

Implication:

- A Codex thread ID is scoped to the state visible under that process's `CODEX_HOME`.
- Exact structured portability is technically present through a rollout path, but Penkra must not make an unstable operation the sole durability contract without an explicit compatibility policy and QA gate.
- `thread/inject_items` is not a substitute for full migration. It accepts raw model-visible items, but recreating every hidden/runtime semantic from Penkra projections would again make Penkra responsible for exact protocol fidelity.

Observed stable shared-state test:

1. Profile A created a thread and injected a structured history item.
2. Profile B used a separate empty `CODEX_HOME`; only its `sessions` entry was mounted from profile A.
3. Profile B resumed the original thread by ID through the stable `thread/resume` shape, without `path` or `history` experimental fields.

This is the strongest Codex direction so far: keep credentials/configuration connection-scoped while mounting Penkra-owned native conversation state into each runtime profile. It still needs tool-, attachment-, subagent-, compaction-, goal-, and crash-heavy tests to identify the complete state bundle. Sharing only `sessions` is not yet assumed sufficient for production.

Observed credential isolation in current upstream source:

- Codex's keyring backend computes its credential entry key from a SHA256 hash of the canonical `CODEX_HOME` path. Separate Penkra-owned `CODEX_HOME` paths therefore receive distinct OS-keychain entries instead of sharing one global Codex login.
- This makes the supported `keyring` credential-store mode preferable to copying `auth.json`. Each Connection can complete Codex's own App Server login flow inside its isolated profile while Codex remains responsible for token refresh.
- Penkra must still scrub inherited OpenAI credentials and force/verify the selected profile before launch.
- A local no-model-call probe confirmed the installed binary reported the existing default `CODEX_HOME` as logged in and a new empty `CODEX_HOME` as logged out. No account identifiers were emitted. Two-real-account switching and refresh still require QA.

### Claude Code / Claude Agent SDK

Documented:

- Sessions are structured JSONL transcripts and resume by session ID.
- The SDK exposes native session forking with UUID remapping and parent-chain preservation.
- `SessionStore` mirrors the exact JSON-safe transcript entries and can materialize them for resume on another process or host.
- `SessionStore.load()` requires entries deep-equal to those appended; byte-identical JSON serialization is unnecessary.
- Subagent transcript restoration requires `listSubkeys()`.
- `CLAUDE_CODE_OAUTH_TOKEN` overrides keychain credentials for SDK/automation use.
- `CLAUDE_CONFIG_DIR` changes settings, credentials, session history, and plugin storage together.
- `SessionStore` is currently marked alpha by the installed SDK (`0.3.207`). It dual-writes only after the local transcript write succeeds.
- Store append failures receive bounded retry; after final failure the batch is dropped, a `mirror_error` system message is emitted, and the Claude subprocess continues. Penkra therefore cannot treat the mirror as authoritative without separately fencing/recording that failure.
- File checkpointing is explicitly unsupported with `SessionStore` because backup blobs are not mirrored. Penkra does not currently enable the SDK's file-checkpointing option, but this must remain an explicit capability constraint.

Observed in Penkra:

- The current Claude adapter uses the SDK's native `resume` option but does not provide a Penkra-owned `SessionStore`.
- The current adapter passes one resolved environment to the SDK subprocess. This is the natural insertion point for a connection-scoped credential environment.

Observed isolated authentication probe on macOS:

- The existing default profile reported logged in through `claude auth status --json`.
- The same installed binary launched with a new empty `CLAUDE_CONFIG_DIR` reported logged out. No account identifiers were emitted by the probe.
- This demonstrates that separate `CLAUDE_CONFIG_DIR` profiles isolate the effective subscription login on this installed Claude Code version, including on macOS where Claude uses Keychain storage. Two-real-account switching and refresh still require QA.

Unresolved:

- Cross-account continuation of the same exact native session, including server-side cache behavior and account authorization constraints.
- Required secure storage and refresh lifecycle for multiple subscription OAuth tokens.
- Exact behavior of compacted, subagent-heavy, attachment-heavy, and interrupted sessions when restored through a Penkra-owned store.
- Whether the alpha `SessionStore` contract is stable enough for the first connection release, or whether a complete connection-scoped `CLAUDE_CONFIG_DIR` with an explicitly shared Penkra-owned `projects` state mount is safer until the contract stabilizes.

#### Claude subscription OAuth policy blocker

Documented by Anthropic's current Legal and Compliance page:

- OAuth authentication is intended for ordinary use of Claude Code and Anthropic's native applications.
- Developers building products or services that use Claude capabilities, explicitly including Agent SDK products, should use Claude Console API keys or a supported cloud provider.
- Anthropic explicitly says third-party developers may not offer Claude.ai login or route Free, Pro, or Max plan credentials on behalf of users.

Implication for Penkra:

- Penkra must not ship a Claude.ai “Add Connection” OAuth flow, collect `claude setup-token` output, or present multiple Pro/Max subscription profiles as a supported product capability under the current published policy.
- The first compliant Claude Connection methods are Claude Console API keys and supported enterprise/cloud-provider credentials (for example Bedrock, Vertex, or Foundry) implemented only when their own isolation/refresh contracts are verified.
- Multiple Claude Connections are still supported architecturally; they may be two API keys/organizations or other permitted credential types. Team/Enterprise OAuth must also be treated as unavailable unless Anthropic confirms the Penkra embedding in writing or the published policy changes.
- Existing local subscription usage in the development environment is evidence for technical isolation only, not permission to productize that authentication method.

This is a product-policy constraint, not a technical limitation and not legal advice. It requires an operator decision after contacting Anthropic if subscription Connections remain a desired launch feature.

### OpenCode / Kilo

Documented:

- The server exposes native session create, messages, fork, summarize, revert, and resume-by-session-ID operations.
- The CLI exposes session export and import.
- Stored credentials normally live in OpenCode's data storage; environment credentials are also supported for providers that declare them.

Observed in an isolated no-model-call test:

1. Profile A created a session and added a `noReply` text part.
2. `opencode export` from profile A was piped into `opencode import /dev/stdin` under profile B.
3. Profile B preserved the exact session ID, message ID, part ID, timestamps, model metadata, and text.
4. No provider request or paid model call was made.

Observed isolation concern:

- Even with isolated XDG data/config/cache paths and `OPENCODE_CONFIG_DIR`, the server also loaded `~/.opencode/opencode.json`.
- Therefore those environment variables alone do not constitute complete configuration isolation.
- This is documented precedence rather than an accidental leak: `OPENCODE_CONFIG_DIR` adds a custom component directory after global configuration; it does not disable global configuration. `OPENCODE_CONFIG` and inline content also merge into the wider precedence chain.

Observed executable resolution:

- `/usr/local/bin/opencode` is the Homebrew `1.18.5` installation.
- the active NVM tree contains an npm-installed `1.18.10` executable.
- A bare `opencode` therefore cannot serve as a stable identity for update checks, runtime launch, or QA. Penkra must bind those actions to an absolute managed/external executable record.

Documented installation boundary:

- OpenCode publishes versioned platform binaries on its official GitHub Releases and supports upgrading to a specific version.
- Release assets expose SHA256 digests in GitHub release metadata. OpenCode is MIT licensed.
- `OPENCODE_DISABLE_AUTOUPDATE` and the `autoupdate` configuration allow Penkra to prevent a runtime from mutating its own managed generation.

Observed credential-storage boundary in current upstream source and this installation:

- OpenCode v1 models OAuth credentials as access token, refresh token, expiry, and optional account ID; API credentials are stored as keys. Its standard `auth.json` is written with mode `0600`; the current installation's file also has mode `0600`.
- `OPENCODE_AUTH_CONTENT` can provide an in-memory JSON credential map, but it takes precedence on every read. Credential refresh writes go to `auth.json` while subsequent reads continue seeing the original environment value. It is therefore suitable for non-refreshing API-key injection, not a safe durable OAuth-refresh contract.
- OpenCode subscription/OAuth Connections should use one isolated connection profile and writable connection-scoped `auth.json`, with a single adapter-owned server/runtime pool per Connection. Conversation state remains a separately mounted Penkra-owned resource.
- Penkra may later wrap the credential file with an OS-secret materialization layer, but it must first solve concurrent runtimes and refreshed-token durability without copying stale tokens over newer ones. File mode alone is not equivalent to an OS keychain.

OpenCode Go is simpler than the generic OAuth case: its official setup gives the subscriber an API key, and OpenCode treats Go like another provider. Two Go accounts can therefore be two Penkra static-secret Connections; they do not require browser OAuth refresh-token isolation. The writable profile mechanism remains necessary for other OpenCode integrations that genuinely use OAuth.

Observed complete local profile boundary:

- A second no-model-call server was launched with an isolated `HOME`, XDG data/config/cache/state roots, `OPENCODE_CONFIG_DIR`, inline config, and Claude-compatibility disabled.
- Debug logs showed configuration reads only under the synthetic home and custom component directory; the real user's global OpenCode configuration was not loaded.
- `/path` reported the synthetic home/state/config directories and `/global/health` reported the expected absolute executable version (`1.18.10`).
- This validates the user's process/shell intuition for OpenCode: a complete environment can isolate a connection. It does not yet solve conversation portability; that remains the separate session export/import or shared-state problem.

Observed shared native-state test:

1. Profile A created a session and a `noReply` message in its OpenCode SQLite database.
2. Profile B used a fully separate home/config/cache/state/data profile, but its `opencode.db` path referenced profile A's database. It had no shared credential file.
3. Profile B read the exact session ID, message ID, part ID, model metadata, and sentinel text through ordinary server APIs.
4. Profiles A and B were then run concurrently against the same database; a session created through A became immediately visible through B in this low-contention probe.

This makes a stable shared native-state mount more promising than export/import for ordinary connection switching. It is not yet production proof: OpenCode auxiliary session state (snapshots, tool outputs, child sessions, repositories), SQLite WAL/locking through platform-specific links, simultaneous active turns, crashes, and provider-version skew still require stress tests. The credential file must remain connection-scoped.

Observed concurrent shared-database stress test on OpenCode 1.18.10, with no model calls:

1. Two servers used separate synthetic `HOME`, XDG config/cache/state/data roots and separate empty credential state.
2. Server B's `opencode.db` was a symbolic link to server A's database. SQLite resolved the link to one WAL/SHM set beside the target database; no competing B-side WAL/SHM files were created.
3. Twenty concurrent workers alternated between the servers and created 200 sessions plus 200 `noReply` text messages. All 200 session/message pairs completed successfully.
4. Each server fetched a session created by the other server through the ordinary API.
5. The database contained the expected 201 synthetic sessions and 201 sentinel text parts including the preliminary single probe. `PRAGMA integrity_check` returned `ok` after both servers stopped.

This materially strengthens the POSIX shared-database direction. It does not prove concurrent model turns, write contention involving summaries/reverts/child sessions, a deterministically injected process death inside a SQLite commit, snapshot repository sharing, long-running WAL checkpoint behavior, network/removable filesystems, or Windows link/locking semantics. Those remain mandatory tests rather than assumptions.

Observed forced-process-death extension, still with no model calls:

1. Both isolated servers were restarted against the same linked database and began 1,000 alternating concurrent synthetic session/message operations.
2. Server B was sent `SIGKILL` while writes were active. The client observed 139 expected connection failures and three cases where session creation committed but the follow-up message could not be sent. Server A continued serving writes.
3. The database contained 861 crash-test sessions and 858 matching text parts, exactly accounting for the three interrupted two-request sequences. SQLite integrity remained `ok`.
4. Server B restarted against the same state and read a complete session/message pair written through server A after the crash.

This shows database durability under one forced server death and, importantly, that Penkra must treat “create session then append message” as two provider operations that can be interrupted between commits. It does not create corruption, but startup reconciliation must recognize an empty native session rather than infer or replay a missing user message.

Unresolved:

- Export/import fidelity for tool calls, tool outputs, binary/file parts, summaries, reversions, permissions, child sessions, and incomplete turns.
- Whether importing an already-present session is idempotent or can conflict with local state.
- Whether OpenCode Go/subscription OAuth credentials can be selected per process without coupling session storage to the credential database.
- Exact behavior of a synthetic home when native plugins, managed configuration, organizational `.well-known` configuration, or provider OAuth refresh flows are active.

### ACP providers: Cursor, Droid, and Grok

Documented by ACP:

- `session/resume` reconnects to provider-owned context without replaying history.
- `session/load` may replay history to the client and is a different capability.
- Resume and fork support are capability-negotiated.

Observed in Penkra:

- Penkra requires ACP `session/resume` for reopening a provider session and fails closed if the agent does not advertise it.
- Penkra intentionally does not substitute `session/load` for resume.
- Droid exposes native fork through ACP; provider-specific comments currently express uncertainty about first-prompt model visibility and trigger an extra Sidechat bootstrap.

Unresolved:

- Whether each ACP provider binds session IDs to the authenticated account/profile.
- Whether a different authenticated ACP process can resume the same session ID.
- Whether compaction state is entirely provider-owned and portable across connection changes.
- Provider-specific credential isolation and refresh behavior.

### Pi

Documented:

- `AgentSession` owns message history, model state, compaction, and event streaming.
- `SessionManager` owns resumable session files independently of `AuthStorage`.
- `AuthStorage` supports a custom credential file and non-persisted runtime API-key overrides.
- Pi session files retain structured compaction entries and branching copies raw entries, preserving compaction boundaries.

Initial implication to test:

- Pi already separates authentication from conversation storage at the SDK layer, making exact connection-scoped credentials with shared provider-native session state plausible without file heuristics.

## Sidechat complexity inventory

Sidechat is not only a presentation feature. It currently spans:

- `/side` composer commands and creation registry;
- specialized `sidechatSourceThreadId` contracts and projected database columns;
- source/Sidechat split activation and reopening behavior;
- right-dock pane metadata and rendering;
- hiding imported fork transcript rows;
- a special safety boundary inserted into every Sidechat prompt;
- native-fork and non-native-fork bootstrap state;
- overlong-input rejection and retry behavior;
- migrations and a large provider-reactor test surface.

Removing Sidechat would remove its specialized prompt boundary and bootstrap paths. It would not by itself remove generic thread forking, imported provider handoff, message edit/rollback recovery, or OpenCode/Kilo restart bootstrapping. Those must be evaluated independently.

## Complexity-reduction candidates

### Approved removal: Sidechats

Sidechats duplicate capabilities already available through ordinary threads, forks, and the right dock while adding their own context policy. Removing them should include the feature end to end, not merely hiding `/side`:

- remove Sidechat creation and reopening behavior;
- remove Sidechat-only dock pane kinds and labels while retaining the generic right dock;
- remove `sidechatSourceThreadId` from current contracts/projections;
- remove the Sidechat boundary prompt and bootstrap state;
- remove Sidechat-only transcript hiding and routing rules;
- retain generic provider-native fork operations.

Before the schema migration, verify whether this installation has any Sidechat records. The operator expects none and has explicitly authorized discarding any that do exist. Historical migrations can remain immutable if the migration framework requires an append-only history, but the current schema should stop carrying live Sidechat semantics after the clean-cut migration.

Read-only preflight on 2026-08-03:

- Penkra's thread API returned 27 total active/archived threads and no thread with an explicit Sidechat creation source.
- The API does not expose `sidechatSourceThreadId`, so this is not conclusive proof that the relationship column is empty. The expected local Dev/production database locations were not present in this workspace environment, so no SQLite claim is made.
- The destructive migration must run a count against its exact opened database immediately before applying the clean cut, log only the count, and then discard any matching records as already authorized. It must not invent a conversion fallback.

### Approved removal: cross-provider Handoff

Penkra's `Handoff to <provider>` feature creates a new thread for a different provider, projects selected visible messages into it, and bootstraps the new provider with a bounded plain-text reconstruction. It is structurally lossy for the same reasons as Sidechat bootstrap and is distinct from:

- importing an existing native session from the same provider;
- switching between two credential connections for the same provider;
- moving a thread between Local and a Git worktree (also called a handoff in parts of the code).

Removing it eliminates the `handoff_context` heuristic, handoff badges/menus, imported-message metadata, and a significant branch of provider startup behavior. The Git workspace handoff should be renamed separately to avoid conflating unrelated concepts, but it need not be removed for connection work.

#### What other products call a handoff

The term covers several different operations; none establish a standard for exact arbitrary cross-provider migration:

- **Specialist delegation:** OpenAI's Agents SDK uses a handoff when one agent delegates the conversation to another specialist agent. The receiving agent normally sees conversation history, with explicit filters available. This is an orchestration pattern inside an application, not a promise that one coding provider's hidden native session has been converted into another provider's session.
- **Same-session surface continuity:** Claude Code Remote Control keeps the same live local session and exposes it from another surface/device. The local process, filesystem, tools, MCP servers, and configuration remain authoritative.
- **Runtime-location continuation:** VS Code's `Continue In` moves a session between local, background, and cloud agent execution while carrying the session context within the product's supported session model.
- **Summary-based transition:** Claude Desktop can prepare a branch and summary when sending work to a remote web session. This is useful workflow transfer, but it is explicitly a newly created remote session rather than proof of identical native state.

The practical use cases are specialist routing, moving work to another device/runtime, or deliberately giving another agent a summarized starting point. Penkra's old cross-provider Handoff most closely matched the last category while presenting itself like continuity. Connections now cover the important quota/account-switching case without changing provider, and native forks cover supported alternate paths. If users later need a second provider's opinion, that should be a visibly new thread with an explicit user-controlled reference/export—not a hidden reconstruction presented as the original session.

### Retain, but make native-only: ordinary Fork

Fork is useful and providers expose native fork operations. The clean contract should be:

- use a provider-native fork when advertised and verified;
- otherwise mark fork unavailable for that provider;
- never silently replace a native fork with a truncated visible-transcript prompt.

### Retain: native session import

Importing an existing Codex, Claude, OpenCode/Kilo, or supported ACP session is valuable and can stay when the provider can resume the imported native state. Projecting provider history into Penkra is a display/indexing concern; it must not trigger an additional context bootstrap after native resume.

### Deferred providers

Codex, Claude Code, and OpenCode are the product commitments for the first connection release. Kilo, Antigravity, Cursor, Droid, Grok, Pi, and other future providers must not shape the first QA matrix or remain as compatibility fallbacks. The architecture must nevertheless make later support additive through the same adapter contract.

## Emerging architecture constraints

The OS/process intuition is correct, but one process environment alone is not the whole boundary. The clean design needs four separately identified resources:

1. **Provider installation** — one exact Penkra-managed executable identity, version, provenance, and update policy. An external installation may be inspected only as an explicit migration source; it is not a runtime fallback.
2. **Connection** — one credential identity and provider-specific configuration, stored securely and selected explicitly.
3. **Native conversation state** — provider session/rollout/transcript data owned per Penkra thread, independent of which connection is active whenever the provider permits it.
4. **Runtime instance** — a short-lived provider process launched from one installation with one connection's environment and one thread's native state mount/store.

Penkra should persist explicit IDs for all four and an append-only connection-change event. No selection should be inferred from a shell's current login, the first credential file found, a display label, or the last process that happened to run.

Current code is not ready for this separation:

- Codex builds one Penkra overlay home and symlinks almost every source-home entry into it, including authentication and sessions. The overlay path is not namespaced by connection or thread. The controlled mount test shows this can be replaced with explicit connection-scoped runtime homes plus a deliberately shared Penkra-owned native-state bundle.
- Claude selects one process environment and resumes from the CLI's combined config/credential/session directory; it does not yet use a Penkra-owned `SessionStore`.
- OpenCode launches from the inherited environment and pools servers by runtime inputs; it does not yet construct a complete connection-scoped home/config/data environment.
- The generic child-environment builder deliberately permits all recognized provider credential variables for Codex, OpenCode/Kilo, ACP, and Pi because those runtimes can proxy multiple upstream providers. A connection launch must instead start from a scrubbed credential environment and explicitly inject only the selected connection's allowed variables; otherwise an inherited shell key can silently override or supplement the chosen identity.
- The durable provider-session directory is keyed by Penkra thread and stores provider/runtime/resume data, but no connection ID. A connection switch currently has nowhere explicit and durable to bind.

The target should use provider-specific adapters behind a shared lifecycle:

- stop accepting new turns on the old runtime;
- require the current turn to be idle, cancelled, or durably settled;
- verify and checkpoint the provider-native state;
- launch a new runtime with the chosen connection and the same exact native state;
- prove native resume before changing the durable active-connection binding;
- append a visible `Connection changed to ...` transcript event;
- on failure, leave the old binding intact and surface the provider error without transcript replay.

Automatic failover is out of scope. A user manually switches after seeing the normal provider limit/auth error.

### Provider-neutral extension contract

Shared orchestration must reason about declared capabilities and stable resource IDs, never about the three initial provider names. Each provider adapter owns its filesystem layout, environment construction, authentication mechanisms, installation source, native-session operations, and event normalization. A prospective adapter must declare and pass conformance tests for capabilities such as:

- connection isolation and credential scrubbing;
- managed installation, version probing, staged activation, and rollback;
- exact native-state materialization, checkpoint, resume, and corruption detection;
- native fork and import when supported;
- usage/cache telemetry normalization when exposed by the provider.

Unsupported capabilities fail closed and are absent from the UI. There is no shared transcript-replay fallback. Persisted resources should use generic installation, connection, thread-provider-state, runtime-binding, and transition-event records with versioned opaque adapter payloads where provider-native identifiers are required. Adding a provider should require an adapter, manifest/UI metadata, migrations only for genuinely new generic concepts, and the full conformance/QA suite—not edits to core switching rules.

`connection.provider_kind` is immutable. A thread's `provider_kind` becomes immutable when its first turn starts. A Connection switch transaction must reject a mismatched provider before stopping the active runtime.

### Credential ownership and storage

The database stores Connection metadata and an opaque credential reference, never an API key, access token, refresh token, provider `auth.json`, or serialized keychain payload. A single universal secret mechanism is not appropriate because provider-owned OAuth refresh must durably update the selected Connection without Penkra racing or overwriting it.

Adapters may implement these credential backends behind the same Connection contract:

1. **Provider-native namespaced profile** — the provider owns login, refresh, logout, and its supported OS-keychain/file representation inside an isolated connection profile. Codex keyring entries are namespaced by `CODEX_HOME`; Claude effective login was observed isolated by `CLAUDE_CONFIG_DIR`; OpenCode OAuth uses a connection-scoped private `auth.json` because it has no documented keychain backend.
2. **Penkra static secret** — Penkra stores a non-refreshing API key/token through an OS-backed secret service and injects only that selected value into the child environment or provider-supported in-memory input. The runtime receives a scrubbed environment containing no credentials from another Connection.

The adapter manifest declares which backend applies to each connection method. Shared code handles lifecycle and redaction but does not parse or migrate provider tokens. Connection metadata may contain only non-secret fields such as display label, provider kind, authentication method, provider-reported account/workspace label where safe, credential reference ID, health status, and timestamps.

Provider-specific implications:

- **Codex subscription/API login:** prefer Codex App Server's managed login methods in a distinct `CODEX_HOME` with `cli_auth_credentials_store = "keyring"`. Codex owns refresh and logout; Penkra records only the connection/profile binding.
- **Claude permitted product credentials:** store Console API keys through Penkra's static-secret backend and inject only `ANTHROPIC_API_KEY` after removing every higher-precedence Claude credential variable/source from the runtime profile. The technically isolated `CLAUDE_CONFIG_DIR` subscription flow is not a shippable Connection method under Anthropic's current published policy without permission.
- **OpenCode Go and static upstream providers:** store each API key through Penkra's static-secret backend and expose only the selected provider credential to the Connection server. For other OpenCode integrations that genuinely use OAuth, use a private connection profile with writable `auth.json`, because refresh tokens must be updated by OpenCode.

Deleting a Connection is a credential-revocation workflow, not a row deletion alone: refuse while it owns an active runtime, invoke the adapter's logout/delete operation, verify the selected profile no longer authenticates, remove its isolated credential material, and only then tombstone metadata. Removing one Connection must not log out another Connection for the same provider.

### Draft durable model for review

Names remain provisional, but the responsibilities must stay separate:

- `provider_installations`: immutable generation ID, provider kind, version, platform/architecture, absolute executable path, source URL/channel, verified digest/signature result, adapter/protocol version, health state, installed/activated timestamps, and retirement state.
- `provider_connections`: immutable Connection ID and provider kind, user label, authentication method, opaque credential/profile reference, non-secret provider account/workspace identity, health state, and lifecycle timestamps. No executable path and no native thread/session ID.
- `thread_provider_states`: one started thread's immutable provider kind, opaque native state locator/version, provider session ID where non-secret, checkpoint generation/status, and last verified resume timestamp. No credential material and no transcript reconstruction.
- `thread_connection_bindings`: current Connection ID, installation generation ID, binding revision, and transition status for a started thread. This is the explicit answer to “which account and executable will the next turn use?”
- `provider_connection_transitions`: append-only old/new Connection IDs, old/new installation generations, phase, reason (`manual_switch`, `login_repair`, `installation_activation`, or `rollback`), sanitized provider error classification, timestamps, and recovery outcome.
- `space_provider_defaults`: optional default Connection by provider for new drafts in a Space. Defaults never rewrite existing thread bindings.

Folder-level Connection defaults are not part of the first release. A Space default can select the usual Connection for a new draft; a draft can override it. Once the first turn starts, the provider is fixed and the chosen Connection becomes the initial explicit thread binding. Later switching is manual and same-provider only.

### Draft Connection-switch state machine for review

Only one transition lease may exist for a thread. The switch control is unavailable while a provider turn, approval, compaction, fork, import, or another transition is unsettled; the user may explicitly cancel/settle the active operation first.

1. **Validate** — confirm thread and target Connection provider kinds match, target credentials are healthy enough to attempt login, target installation generation is verified, and native resume is declared supported. No runtime is stopped yet.
2. **Fence** — acquire the thread transition lease and reject new turns. Persist `preparing` with the old binding revision.
3. **Checkpoint** — ask the old adapter/runtime to flush and checkpoint exact native state. Persist its durable checkpoint identity and `checkpointed` phase. Failure leaves the old binding active.
4. **Quiesce** — stop or detach the old runtime without deleting its native state or credentials. Persist `old_runtime_stopped` only after process ownership is gone.
5. **Probe target** — start the target Connection with its isolated profile and the same native-state resource. Perform provider-native resume and verify the expected session identity/checkpoint without sending a model turn.
6. **Commit** — in one database transaction, update the binding revision, mark the transition committed, and append the visible `Connection changed to …` transcript event. Only now may a new turn start on the target.
7. **Retire old runtime** — release old runtime resources while retaining the old Connection and immutable installation generation for other threads/rollback.

Recovery is phase-driven, not inferred:

- before `checkpointed`: keep/restart the old binding;
- after checkpoint but before target resume proof: resume the old binding from that checkpoint;
- after target proof but before commit: do not guess—re-run idempotent target proof and commit only when the stored binding revision still matches;
- after commit: the target binding is authoritative, even if cleanup of the old runtime must be retried;
- any provider-native state mismatch or corruption fails closed with both Connections preserved and no transcript injection.

## Runtime installation and update boundary

Connections must not own their own provider binary, and a provider binary must not imply an account. Managed installations are the approved default. The OpenCode dual-install finding demonstrates why:

- Penkra-managed installations should live under Penkra's data directory, use an absolute executable path, download/install into a staging generation, verify version/health, then atomically activate the generation only when no incompatible live runtime owns it.
- Homebrew, NVM/npm-global, and other external installations may be detected only for an explicit migration/import flow. Penkra must not silently run `brew upgrade`, mutate a user's global npm tree, or continue choosing a runtime from `PATH` after migration.
- For this single-user clean cut, install and select Penkra-managed generations for Codex, Claude Code, and OpenCode. Existing external copies remain outside Penkra and are not compatibility fallbacks.
- Update checks, update installation, runtime launch, rollback, and QA must all reference the same installation ID/path. A bare command name is insufficient.

Managed does not automatically mean legally redistributing a bundled binary. The provider adapter may install an official package on demand into Penkra-owned storage. Before implementation, research must confirm each provider's official distribution channel, license/terms, integrity metadata, authentication bootstrap, platform/architecture matrix, and downgrade availability.

### Managed installation findings

| Provider | Recommended Penkra-managed source | Integrity and rollback evidence | Runtime update control |
| --- | --- | --- | --- |
| Codex | Resolve a stable version through OpenAI's official release metadata and download the exact platform archive into a new Penkra generation. Do not invoke Homebrew/npm or select from `PATH`. | Official releases provide platform archives, `codex-package_SHA256SUMS`, and GitHub release SHA256 digests. Exact older release assets remain addressable, so Penkra can retain N while staging N+1. | Disable in-app updates through managed requirements where applicable; Penkra alone activates generations. |
| Claude Code | Download the exact native binary from Anthropic's documented versioned release bucket into a Penkra generation. A Penkra-owned launcher may select a pinned version. | Every current release has a SHA256 manifest; releases from 2.1.89 onward have a detached GPG signature. macOS and Windows binaries also have native code signatures. The installer accepts exact versions, and Anthropic documents retained version files with custom launchers. | Set `DISABLE_UPDATES=1` for managed runtimes, not merely `DISABLE_AUTOUPDATER`, so neither background nor manual provider self-update can mutate the generation. |
| OpenCode | Download the exact versioned platform archive from the official `anomalyco/opencode` GitHub release into a Penkra generation. | GitHub release metadata exposes a SHA256 digest for each archive, and older tagged assets are directly addressable. | Set `OPENCODE_DISABLE_AUTOUPDATE=1` and managed `autoupdate: false`; never run `opencode upgrade` inside an active generation. |

The first implementation should fetch official artifacts at install/update time rather than bundle third-party binaries inside Penkra. Codex and OpenCode have permissive open-source licenses, but the product must still retain required notices. Claude Code is distributed under Anthropic's product terms rather than an open-source repository license; redistribution/bundling remains unresolved, while on-demand retrieval from Anthropic's official signed release channel is the narrower design.

All adapters should implement the same two-phase installation protocol:

1. Resolve an immutable version and platform artifact.
2. Download into a fresh staging directory.
3. Verify the provider's strongest supported integrity evidence before extraction/activation.
4. Probe the absolute executable for version, protocol/capabilities, and a no-model-call health check.
5. Record the verified digest, source URL, platform, architecture, adapter version, and probe result.
6. Atomically mark the generation eligible for new runtimes while existing processes retain their original generation.
7. Run exact native-session restart/resume QA before making it the default.
8. Roll back the default pointer without modifying either immutable generation if the probe or resume gate fails.

The update QA fixture needs at least two real or packaged provider versions: keep active threads on generation N, stage N+1, activate it, restart/resume exact native sessions, verify rollback to N on health or compatibility failure, and prove the old process tree is gone before cleanup.

## Cache behavior when switching connections

Preserving native conversation state does not guarantee preserving a provider-side prompt-cache entry:

- OpenAI documents prompt caches as isolated between organizations.
- Anthropic documents prompt-cache isolation per workspace for the Claude API/Claude Platform on AWS/Microsoft Foundry, and per organization on Bedrock/Google Cloud.
- Cache hits also depend on an exact matching prefix and provider-controlled TTLs.

Therefore a switch can continue the exact conversation yet receive a cold cache on the first turn under the new connection. Penkra should not describe that as context loss or attempt to compensate by altering/replaying the transcript. QA should capture provider-reported cache-read/cache-write token fields where available so this cost/latency effect is visible rather than guessed.

## Required test matrix before architecture

For every supported provider and connection type:

- new thread under connection A;
- ordinary restart under connection A;
- native compaction, restart, and continuation;
- tool-heavy and attachment-heavy continuation;
- interrupted and approval-waiting turn boundaries;
- manual switch A to B and B back to A;
- switch after compaction;
- switch after provider update;
- missing/stale/corrupt native session state;
- concurrent threads on different connections;
- credential refresh while another connection remains active;
- provider logout or credential revocation isolation;
- prompt-cache/token-usage observations where providers expose them;
- crash between old-session close and new-session binding;
- application restart during each transition phase.

Each run must capture sanitized structured provider events, Penkra orchestration events, connection ID, provider session ID, transition phase, exact failure classification, and visual/manual QA outcome. Credentials, authorization headers, raw tokens, and sensitive tool output must never enter logs.

## Sources consulted

- OpenAI Codex App Server: <https://learn.chatgpt.com/docs/app-server>
- OpenAI Codex authentication: <https://learn.chatgpt.com/docs/auth>
- OpenAI Codex advanced configuration: <https://learn.chatgpt.com/docs/config-file/config-advanced>
- OpenAI Codex official repository and installation: <https://github.com/openai/codex>
- OpenAI Codex current keyring storage implementation: <https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs>
- Claude Code sessions: <https://code.claude.com/docs/en/sessions>
- Claude Code authentication: <https://code.claude.com/docs/en/team>
- Claude Code installation and binary verification: <https://code.claude.com/docs/en/installation>
- Claude Code authentication precedence and storage: <https://code.claude.com/docs/en/authentication>
- Claude Code legal, authentication, and credential-use policy: <https://code.claude.com/docs/en/legal-and-compliance>
- Claude Agent SDK session storage: <https://code.claude.com/docs/en/agent-sdk/session-storage>
- OpenCode server: <https://opencode.ai/docs/server>
- OpenCode SDK: <https://opencode.ai/docs/sdk>
- OpenCode providers: <https://opencode.ai/docs/providers>
- OpenCode installation: <https://opencode.ai/docs>
- OpenCode releases: <https://github.com/anomalyco/opencode/releases>
- OpenCode Go: <https://opencode.ai/docs/go>
- OpenCode hosted-services terms: <https://opencode.ai/legal/terms-of-service>
- OpenAI Agents SDK handoffs: <https://openai.github.io/openai-agents-python/handoffs/>
- Claude Code Remote Control: <https://code.claude.com/docs/en/remote-control>
- Claude Desktop web handoff: <https://code.claude.com/docs/en/desktop>
- VS Code agent sessions and execution locations: <https://code.visualstudio.com/learn/foundations/agent-sessions-and-where-agents-run>
- ACP session resume: <https://agentclientprotocol.com/announcements/session-resume-stabilized>
- Pi SDK: <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md>
- Pi compaction: <https://pi.dev/docs/latest/compaction>
