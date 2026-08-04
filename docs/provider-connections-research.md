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

Multiple Connections remain required. Authentication methods are separately capability-gated so the same architecture can support a method in a personal/development installation while genuinely disabling that method in a distribution channel when provider policy requires it; see the Claude policy finding and operator decision below.

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

Initial questions and disposition:

- Stable resume across isolated `CODEX_HOME` values is supported when the exact provider state is shared; the controlled probes below prove resume-by-ID without experimental request fields. Real independently authenticated accounts and the full state manifest still require QA.
- Experimental history/path resume is excluded from the architecture, so its reconstruction fidelity is not a release dependency.
- Experimental host-managed ChatGPT tokens are excluded from the first release; Codex-managed login in Connection-scoped profiles is the selected credential contract.
- Multiple app-server processes referencing the same provider state still require model/tool-heavy concurrency and crash QA. Until proven, the adapter may enforce one active owner per Codex native-state generation rather than assume provider concurrency.

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

Current official App Server authentication contract:

- Managed ChatGPT login is stable: Codex owns browser/device-code login, credential persistence, refresh, logout, account inspection, and rate-limit reporting.
- Host-supplied ChatGPT tokens exist, but the protocol marks that mode experimental and makes the host responsible for refresh after authorization failures. It should not be the first-release durability contract.
- The first release should therefore perform Codex's managed login once inside each Connection-scoped `CODEX_HOME`, require the keyring credential store, and mount only the explicitly verified Penkra-owned native conversation-state bundle into those profiles. The stable shared-session probe already demonstrated resume-by-ID across two otherwise isolated homes.
- Every launch must verify `account/read` against the selected Connection before accepting a turn. A successful filesystem resume with the wrong authenticated account is not a successful Connection switch.

Current upstream native-state layout finding:

- Codex now exposes an explicit `sqlite_home`/`CODEX_SQLITE_HOME` boundary. The state runtime places thread metadata, goals, memories, logs, and materialized thread history databases beneath it, so those databases can be shared independently of a Connection-scoped `CODEX_HOME`.
- The thread metadata schema stores `rollout_path` as an absolute path, and current upstream types explicitly describe it that way. A common `sqlite_home` can therefore still point into whichever profile path originally created a rollout. Deleting or relocating that profile could make the shared database unusable even though its SQLite files remain intact.
- Local rollouts and several required companion resources still resolve from `CODEX_HOME`: active `sessions`, `archived_sessions`, `session_index.jsonl`, user/thread attachments, and shell snapshots. Other tool surfaces may create generated-image, browser, computer-use, and REPL artifacts referenced by thread events.
- Therefore “share only `sessions`” is insufficient for the complete Penkra experience even though it passed the minimal resume probe. The leading topology is a stable Penkra-owned conversation-state mount path that is identical inside every Connection runtime, with a common `sqlite_home` plus explicit rollout/index/attachment/tool-state resources. Auth, login logs, mutable user config, and provider caches remain Connection-scoped or Penkra-managed. Penkra must not rewrite provider database paths as an undocumented migration shortcut.
- A controlled no-model-call probe exercised that lifecycle on Codex 0.146.0. A created a thread and injected a marker into its native rollout; B used its own `CODEX_HOME` and the common `CODEX_SQLITE_HOME`, resumed the same thread ID, exited, restarted, and resumed it again. The database continued to point to A's absolute rollout. After A's non-conversation profile entries (`config.toml`, installation marker, skills/temp/migration state) were moved away while its `sessions` and `shell_snapshots` skeleton remained, a fresh B process still resumed and read the same native thread and marker.
- This validates immutable referenced state skeletons as a viable clean lifecycle: deleting a Connection removes/revokes its credential and mutable account profile, but cannot delete a provider path still referenced by a thread-native state generation. The filesystem resource must be owned by that native-state generation, not semantically by the deleted Connection, even if Codex's absolute path lies beneath the original profile namespace.
- The probe did not use a real account, model turn, tool, attachment, compaction, subagent, goal, or memory. The exact retained manifest therefore remains a conformance gate. If a complete manifest cannot be proven without unstable protocol fields or provider-file surgery, cross-Connection resume must remain unavailable; visible-transcript replay is not an alternative.
- A managed Codex update must diff its observed top-level state writes against the previous adapter manifest and fail the upgrade conformance gate when an unclassified path appears. It must not silently leave new conversation state trapped inside one Connection profile.

Observed two-real-account A→B→A continuation on 2026-08-03:

1. Two temporary Connection-scoped `CODEX_HOME` profiles completed Codex's device authorization with `cli_auth_credentials_store = "keyring"`. App Server `account/read` reported two distinct keyed-local identity fingerprints; one account reported Pro and the other Free. Raw identifiers were not logged.
2. An initial status check without the managed keyring requirement reported logged out even though login had succeeded; applying the same requirement reported the expected ChatGPT login. The adapter must therefore apply and verify its credential-store requirement consistently across login, status, App Server launch, logout, and recovery.
3. Connection A created one native thread and completed a short `gpt-5.4-mini`/low-effort marker turn. Connection B, using a separate authenticated home and the common provider state, resumed the same thread ID and correctly returned A's prior marker plus B's new marker. A fresh A runtime then resumed the same ID and correctly returned both prior markers plus a third.
4. The native rollout contained exactly three assistant message items with the expected cumulative marker visibility. It remained at A's absolute `sessions` path while all three turns and the shared SQLite metadata completed successfully. No Penkra transcript text or experimental path/history resume field was supplied.

This proves real cross-account native context continuity and credential selection for the simple-turn case. The following probes extend that evidence beyond plain text.

Observed tool and image continuation across the same two real Codex accounts:

- In a new thread, A executed one native shell-command item to read a fixture and persisted one `function_call` plus one `function_call_output`. B resumed the same thread with no new command and returned the tool-derived marker.
- In another thread, A attached a PNG through Codex's native image input and persisted one inline `input_image` block in the rollout. B resumed the same thread without the image or any command and correctly identified the earlier icon.
- Isolating the process `HOME` as well as `CODEX_HOME` caused the macOS keyring backend to fail before inference because no default Keychain was reachable. Restoring the real OS user home while retaining isolated `CODEX_HOME` fixed it. The launch contract must isolate provider state without severing the OS credential service.

These tests extend the retained-state proof to structured tool and image items. Compaction, subagents/goals/memory, interruption, usage attribution, and revocation remain open.

### Claude Code / Claude Agent SDK

Documented:

- Sessions are structured JSONL transcripts and resume by session ID.
- The SDK exposes native session forking with UUID remapping and parent-chain preservation.
- `SessionStore` mirrors the exact JSON-safe transcript entries and can materialize them for resume on another process or host.
- `SessionStore.load()` requires entries deep-equal to those appended; byte-identical JSON serialization is unnecessary.
- Subagent transcript restoration requires `listSubkeys()`.
- `CLAUDE_CODE_OAUTH_TOKEN` overrides keychain credentials for SDK/automation use.
- Claude's current authentication documentation describes `claude setup-token` as producing a one-year subscription OAuth token for CI/scripts without saving it locally, and says Agent SDK/`claude -p` subscription usage draws from a separate monthly Agent SDK credit beginning June 15, 2026.
- `CLAUDE_CONFIG_DIR` moves settings, credentials, session history, and plugins together. Claude documents separate values as a way to run multiple accounts side by side, but that also separates their local session histories.
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

Observed fake-credential precedence probe, with a synthetic home/config directory and no model call:

- OAuth sentinel only: `auth status` reported logged in through `oauth_token`.
- API-key sentinel only: `auth status` reported logged in through `api_key`.
- Both sentinels present: `auth status` reported `oauth_token`.
- Neither present: the synthetic profile reported logged out.

The sentinels were not real credentials and no provider inference request was made. This proves only local credential selection/status behavior, not which account would be billed for a model turn. It also demonstrates why Penkra must inject exactly one method and scrub every competitor instead of relying on a remembered precedence table.

Leading personal/development Connection strategy after the current authentication findings:

- Store each `claude setup-token` result as a Penkra static secret. Do not copy it into the database, a provider settings file, or a Connection-scoped transcript directory.
- Launch every Claude runtime with a Penkra-owned, provider-state `CLAUDE_CONFIG_DIR` rather than the operator's global profile, and inject exactly one selected Connection credential. A subscription Connection receives only `CLAUDE_CODE_OAUTH_TOKEN`; an API-key Connection receives only `ANTHROPIC_API_KEY`.
- Scrub all competing Anthropic, Bedrock, Vertex, Foundry, proxy-auth, refresh-token, and inherited provider-login sources before launch. Environment precedence must be verified through provider-reported auth status; it is not enough to assume the selected variable won.
- Enable and test Claude's subprocess credential scrubbing so Bash tools, hooks, and MCP subprocesses do not inherit the selected token unless an explicit provider requirement makes that impossible.
- Keep the exact native session history in the same Penkra-owned provider-state root while changing only the process credential between Connections. This follows Claude's documented local-resume model and avoids reconstructing context or coupling a thread to an account profile.

This is cleaner than using one complete `CLAUDE_CONFIG_DIR` per Connection: Claude explicitly combines credentials and session history under that boundary, which would force Penkra either to move native state between profiles or depend on filesystem links. It is also safer than making the alpha `SessionStore` mirror the sole authority. `SessionStore` remains useful for durability and conformance testing, but its documented best-effort mirror can emit `mirror_error` and continue after a missed batch. The current installed SDK declaration and current web documentation also disagree on whether rejected appends receive bounded retry, so Penkra must treat any mirror error as a checkpoint failure regardless of retry count.

Real-account QA must distinguish simple native continuation from the harder cases: compaction, tools/subagents, attachments, interruption, API-key switching, expiry/revocation, and provider-reported account/usage attribution. No production claim is made from environment precedence alone.

Observed two-subscription-token A→B→A continuation on 2026-08-03:

1. The operator completed two separate `claude setup-token` subscription authorizations. Each resulting one-year token was captured directly into a distinct `0600` temporary file, never printed into chat/tool output, and had a distinct local fingerprint. `claude auth status --json` reported `oauth_token` for both, but exposes no account identifier; Penkra must not claim provider-verified identity from that status shape.
2. Both Connections launched with an otherwise empty environment, the same Penkra-owned `CLAUDE_CONFIG_DIR`, and exactly one selected `CLAUDE_CODE_OAUTH_TOKEN`. A created a Haiku/low-effort native session; B resumed the exact session ID and returned A's prior marker plus B's marker; A resumed it again and returned both prior markers plus a third. All commands reported success and no visible transcript was supplied.
3. Provider usage showed a cold account switch: A's first turn created 6,250 cache-input tokens; B read zero cached tokens and created 6,333; returning to A read 6,250 cached tokens and created only 185. This demonstrates exact native context continuity does not imply a shared provider-side cache, and switching back can recover the original account's cache entry.
4. The shared state root contained the native project/session JSONL plus provider policy/remote settings and local metadata. It did not require a Connection-specific transcript copy.

Observed native compaction and API-key failure isolation on the same session:

1. Subscription A invoked Claude's native `/compact`. The provider wrote a `compact_boundary` and compact summary into the same JSONL, reporting 6,546 pre-compaction tokens, 495 post-compaction tokens, and 6,051 cumulatively dropped tokens.
2. Subscription B resumed that exact session ID after compaction and returned all three prior markers plus a fourth. It reported 6,133 cache-read tokens and 912 cache-creation tokens; no Penkra-generated summary or transcript was supplied.
3. A separately captured Claude Console API key then attempted to resume the compacted session with an otherwise empty credential environment. The provider selected the API-key path but returned `Credit balance is too low` before inference, with zero input/output/cache tokens. It did not fall through to either subscription token.
4. Subscription A immediately resumed the unchanged native session afterward and returned every prior marker. The failed Connection did not mutate the binding/state into an unrecoverable form.

This proves subscription-token switching, cache isolation, native compaction continuity, and fail-closed API-key selection. The following probes extend that evidence to provider-native structured items.

Observed tool, image, and subagent continuation across the same two subscription Connections:

- A used one native `Read` tool call and persisted one tool-use plus one tool-result block. B resumed the same session with tools disabled and returned the marker produced by that tool result.
- A sent a PNG as an actual SDK base64 image content block. B resumed the same session without the image or tools and correctly identified the earlier icon. The native JSONL retained one image block.
- A delegated fixture reading to a native subagent. The provider wrote the main session JSONL plus `<session-id>/subagents/agent-*.jsonl` and a companion `.meta.json`; B resumed with tools disabled and returned the subagent-derived marker. Copying only the main JSONL would therefore be incomplete even when ordinary turns appear to work.

The first-release Claude manifest must retain the complete project-session entry and its same-ID auxiliary directory. Tasks, spilled tool output, plans, interruption, expiry/revocation, and funded API-key inference still require proof.

Remaining real-account/provider-state gates:

- A funded API-key Connection must complete a model turn on the same compacted native session and switch back; the captured key currently cannot establish this because its Console account has insufficient credit.
- Rotation, revocation, expiry, and reauthorization behavior for multiple one-year subscription tokens; Penkra must never silently fall through to keychain login when one expires.
- Exact behavior of subagent-heavy, attachment-heavy, and interrupted sessions when restored through a Penkra-owned store. Simple manual compaction across subscription Connections is now proven.
- Whether the Penkra-owned Claude native-state root plus per-process selected credential preserves every auxiliary session resource (subagents, spilled tool results, tasks, plans, debug state, and optional file history) across real-account switches. `SessionStore` may be retained as a secondary durability mirror only after its conformance suite and mirror-error recovery pass; it is not the first-release source of truth.

#### Claude subscription OAuth policy blocker

Documented by Anthropic's current Legal and Compliance page:

- OAuth authentication is intended for ordinary use of Claude Code and Anthropic's native applications.
- Developers building products or services that use Claude capabilities, explicitly including Agent SDK products, should use Claude Console API keys or a supported cloud provider.
- Anthropic explicitly says third-party developers may not offer Claude.ai login or route Free, Pro, or Max plan credentials on behalf of users.

Implication for Penkra:

- A generally distributed Penkra build must not enable a Claude.ai “Add Connection” flow or multiple Pro/Max subscription profiles under the current published legal restriction unless Anthropic confirms the embedding or its policy changes. The operator's personal/development channel is separately capability-enabled below.
- The first compliant Claude Connection methods are Claude Console API keys and supported enterprise/cloud-provider credentials (for example Bedrock, Vertex, or Foundry) implemented only when their own isolation/refresh contracts are verified.
- Multiple Claude Connections are still supported architecturally; they may be two API keys/organizations or other permitted credential types. Team/Enterprise OAuth must also be treated as unavailable unless Anthropic confirms the Penkra embedding in writing or the published policy changes.
- Existing local subscription usage in the development environment is evidence for technical isolation only, not permission to productize that authentication method.

This is a product-policy constraint, not a technical limitation and not legal advice. It requires an operator decision after contacting Anthropic if subscription Connections remain a desired launch feature.

Operator decision on 2026-08-03:

- Continue researching and implementing multiple Claude subscription Connections for the operator's personal/development installation.
- Model subscription OAuth as an ordinary adapter-declared authentication capability, not a Claude-specific branch in shared Connection code.
- Allow release/distribution policy to disable that authentication method without removing Claude API-key Connections or changing thread/session architecture.
- “Disabled” must be enforced through capability resolution, RPC/command validation, login initiation, runtime launch, settings/default validation, and UI availability. It must not be a cosmetic hidden control with a still-callable backend path.
- Preserve the documented Anthropic policy finding so a future distribution decision is explicit rather than accidental.

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

OpenCode Go is simpler than the generic OAuth case: its official setup gives the subscriber an API key, and OpenCode treats Go like another provider. Two Go accounts can therefore be two Penkra static-secret Connections; they do not require browser OAuth refresh-token isolation. Go is specifically provider ID `opencode-go` with model IDs `opencode-go/<model-id>` and the Go endpoint/catalog; it is not the general `opencode` Zen/pay-as-you-go provider. The adapter manifest must keep those authentication methods, catalogs, usage limits, and billing errors distinct even though both are operated by OpenCode. The writable profile mechanism remains necessary for other OpenCode integrations that genuinely use OAuth.

Current upstream native-state layout finding:

- OpenCode exposes `OPENCODE_DB`; an absolute value selects the exact SQLite database independently of the synthetic home/XDG data root. This is cleaner and more portable than the symbolic-link probe used earlier.
- The database is not the complete experience. The same XDG data root also owns `snapshot` Git stores, plan files, spilled tool output, repositories/worktree metadata, and `auth.json`; MCP OAuth has another credential file.
- For the first-release static-key methods, use one Penkra-owned OpenCode data/state root with no durable provider `auth.json`, set the common database explicitly, and inject only the selected static credential through `OPENCODE_AUTH_CONTENT`. This preserves database and auxiliary state across Connection changes without sharing a credential file.
- For a future refreshable OAuth method, use a Connection-private credential data root and the common absolute database, then explicitly mount/version the snapshot, plan, and tool-output resources needed for exact continuation. That method remains unavailable until refresh durability and the auxiliary-state conformance tests pass.

Observed absolute-database/static-credential probe on OpenCode 1.18.10, with no model call:

1. Two servers received different fake API-key auth maps, one common synthetic home/XDG data root, and the same absolute `OPENCODE_DB` path.
2. Starting both simultaneously against a brand-new database caused one server to fail initialization with `database is locked`; the other completed startup. Retrying the failed server after initialization succeeded.
3. Server A created a session and one `noReply` text part. Server B read that exact session/message through the ordinary API.
4. No `auth.json` was created, and `PRAGMA integrity_check` returned `ok` after the cross-server read.

Implication: the absolute database override removes the symbolic-link dependency, but Penkra must own a single-flight initialization/migration lease per OpenCode native-state generation. Only after one verified initializer completes may multiple Connection runtimes open the database. Steady-state concurrency and crash recovery remain covered by the earlier stress probes; first-open migration contention is a distinct lifecycle phase.

Observed two-real-OpenCode-Go-key A→B→A continuation on 2026-08-03:

1. The operator supplied two distinct protected API keys. With each key injected only under `OPENCODE_AUTH_CONTENT` for provider `opencode-go`, OpenCode 1.18.10 exposed the current Go catalog, including DeepSeek V4 Flash/Pro, GLM-5.1/5.2, Kimi, MiMo, MiniMax, Qwen, Grok 4.5, and other current entries.
2. An initial QA attempt incorrectly selected `opencode/gpt-5.4-mini`, which is the separate Zen/pay-as-you-go provider. One key returned a Zen `CreditsError` and the other completed through Zen balance. Those calls are excluded from Go evidence. This demonstrates why catalog visibility is not proof of subscription entitlement and why stable provider/authentication-method IDs must control the picker.
3. Corrected QA used the Go-included `opencode-go/deepseek-v4-flash` model in a fresh native-state generation. A created a session and marker turn; B resumed the same native session ID and returned A's marker plus B's marker; A resumed it again and returned both markers plus a third. No projected transcript was supplied.
4. Each turn produced provider token/cost telemetry; B and returning A also reported cache reads. The shared SQLite integrity check returned `ok`, and no `auth.json` existed anywhere in the synthetic state root.

This proves simple Go static-key switching and exact native continuation. The runtime does not expose a provider account identity for these keys, so Penkra must not label them with an inferred workspace. Operator labels and explicit key replacement remain separate from any provider-verified identity.

Observed tool and image continuation across the same two Go keys:

- Using the Go-included DeepSeek V4 Flash model, A persisted a native tool part/result after reading a fixture. B resumed the same session and returned the tool-derived marker.
- DeepSeek V4 Flash's authenticated model metadata declares `attachment: false` and `image: false`. An attempted image turn persisted the native `image/png` file part but correctly reported that the model could not inspect it; this is a capability rejection, not state loss.
- The authenticated Go metadata declares `opencode-go/gpt-5.6-luna` attachment/image/PDF capable. With that model, A inspected the PNG and B resumed the same session without receiving it again, then correctly identified the earlier icon. The file part remained in the native session export.
- In a real in-flight interruption probe, Connection A was terminated immediately after the native `step-start` of a long generation, before any text or `step-finish`. Connection B resumed that exact session ID, completed an explicit recovery turn instead of continuing the aborted output, and the database integrity check remained `ok`. A separate sleep-tool attempt completed too early and is excluded from crash evidence.

Model capability metadata must gate the composer and adapter request before a turn; provider membership alone is insufficient. The state manifest must preserve the common database plus file/snapshot/tool-output resources used by declared capabilities.

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

Remaining gates:

- Native import is a separate optional capability. Its fidelity and idempotency for tool calls, binary/file parts, summaries, reversions, permissions, child sessions, and incomplete turns must pass its own conformance suite; it is not needed for ordinary Connection switching and has no replay fallback.
- OpenCode Go usage and same-session continuity are now proven with two real keys. Provider-verified workspace identity remains unavailable in the tested surface and must not be inferred; revocation, exhaustion, and complete auxiliary-state behavior still require QA.
- Refreshable OpenCode OAuth is deferred and unavailable until Connection-private refresh durability and auxiliary-state mounts pass. It does not block the static-key first release.
- Synthetic-home QA must include native plugins, managed configuration, organizational `.well-known` configuration, and project-discovered settings so none can introduce an undeclared credential or state root.

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

The adapter surface should be lifecycle-shaped rather than a bag of provider commands:

- `installation`: resolve an immutable artifact, stage, verify integrity, probe protocol/capabilities, activate, retire, and roll back;
- `authentication`: declare method capabilities, create/complete login, identify the selected account safely, health-check, reauthorize, and revoke;
- `nativeState`: create a versioned state generation, enumerate its manifest, checkpoint, prove exact resume, detect corruption, and invoke native fork/import only when declared;
- `runtime`: build a scrubbed launch specification, start, fence, quiesce, stop, and report process ownership without exposing raw credentials;
- `telemetry`: normalize only documented usage/cache/limit fields and sanitized provider errors.

Every method receives stable resource IDs and opaque versioned adapter payloads. Shared orchestration never supplies transcript text to `nativeState.resume`, never mutates provider files directly, and never infers success from a process merely remaining alive. An adapter version cannot become eligible for activation until its manifest and lifecycle pass the generic conformance harness against the exact managed provider generation.

`connection.provider_kind` is immutable. A thread's `provider_kind` becomes immutable when its first turn starts. A Connection switch transaction must reject a mismatched provider before stopping the active runtime.

### Authentication-method capability policy

Authentication availability is a three-way adapter contract, not a provider-name conditional:

- `supported` means the installed adapter knows how to create, validate, launch, refresh, and revoke that authentication method.
- `enabled` means the current trusted release policy permits the supported method in this Penkra channel.
- `available` means both are true and the required managed provider installation/platform prerequisites are healthy.

Each adapter manifest declares stable authentication-method IDs, credential backend, login mechanism, required environment scrub set, and lifecycle operations. A trusted release capability policy enables a subset of those IDs. Personal/development policy may enable Claude subscription login; a distribution policy may omit it while enabling Claude API-key or supported cloud Connections. Shared orchestration receives only the resolved capability result and never contains a `provider_kind === "claude"` exception.

The release policy is configuration authority, not user data. A client request, stale browser bundle, imported database row, deep link, or inherited shell credential cannot enable a method that the running server policy disabled. The server must perform the same capability check when creating a Connection, beginning login, validating credentials, setting a default, launching a runtime, starting a turn, and switching a thread. Runtime environment construction must also scrub credentials for disabled or unselected methods so a globally logged-in provider executable cannot bypass the selected Connection.

If an application update changes a previously enabled method to disabled:

1. Keep its Connection metadata, opaque credential/profile reference, native thread state, transcript, and transition history. Do not delete, log out, convert, or relabel it as another authentication method.
2. Mark the Connection unavailable with a stable non-secret reason and show it in management UI so the user understands why bound threads cannot run. It is not offered in new-draft or switch pickers as a usable target.
3. Reject new turns and runtime launches through it. On a live policy change, fence new turns, allow an already accepted turn to settle or be explicitly cancelled, then stop that runtime; ordinary packaged policy changes take effect on application restart before provider runtimes launch.
4. Leave a Space default or thread binding pointing at the unavailable Connection visible but unresolved. Do not silently choose another Connection, clear the binding, or use a shell login. The user explicitly selects another same-provider Connection where switching is natively supported.
5. Re-enabling the same method makes the preserved Connection eligible for an explicit health check and reuse. It does not require transcript migration or automatic rebinding.

`authentication_method_id` is immutable for a Connection. Moving from a subscription login to an API key creates a different Connection; it is never an in-place credential-type conversion. This keeps policy changes reversible without weakening the no-fallback rule.

### Credential ownership and storage

The database stores Connection metadata and an opaque credential reference, never an API key, access token, refresh token, provider `auth.json`, or serialized keychain payload. A single universal secret mechanism is not appropriate because provider-owned OAuth refresh must durably update the selected Connection without Penkra racing or overwriting it.

Adapters may implement these credential backends behind the same Connection contract:

1. **Provider-native namespaced profile** — the provider owns login, refresh, logout, and its supported OS-keychain/file representation inside an isolated connection profile. Codex keyring entries are namespaced by `CODEX_HOME`; Claude effective login was observed isolated by `CLAUDE_CONFIG_DIR`; OpenCode OAuth uses a connection-scoped private `auth.json` because it has no documented keychain backend.
2. **Penkra static secret** — Penkra stores a non-refreshing API key/token through an OS-backed secret service and injects only that selected value into the child environment or provider-supported in-memory input. The runtime receives a scrubbed environment containing no credentials from another Connection.

The adapter manifest declares which backend applies to each connection method. Shared code handles lifecycle and redaction but does not parse or migrate provider tokens. Connection metadata may contain only non-secret fields such as display label, provider kind, authentication method, provider-reported account/workspace label where safe, credential reference ID, health status, and timestamps.

Penkra desktop secret-backend finding:

- Penkra is an Electron application and already uses `safeStorage` in the trusted main process through an atomic encrypted `AppDataVault`. The renderer never receives its raw secret values.
- Electron documents macOS Keychain and Windows DPAPI as the backing protection. Linux varies by desktop secret service; the synchronous API can select `basic_text`, which uses a hard-coded plaintext password and is not acceptable for provider credentials.
- The archived `keytar` package is not an appropriate new dependency. Reuse the proven Penkra vault pattern in a dedicated provider-Connection vault whose encrypted records live outside SQLite; the database keeps only an opaque vault record ID.
- The desktop main process is the secret authority. The backend requests a secret for one authenticated runtime-launch/revocation operation over a private per-launch capability channel; the renderer, browser storage, logs, argv, and ordinary RPC responses never receive it. The backend retains plaintext only long enough to construct the selected provider process input/environment and zeroes owned buffers where the runtime permits.
- On Linux, `basic_text`, `unknown`, temporarily unavailable encryption, or any inability to identify a protected backend disables Penkra static-secret authentication methods. It never downgrades to plaintext. Provider-native credential profiles can remain available only if their own secure backend independently verifies healthy.
- A standalone/headless backend without the trusted desktop secret broker must advertise static-secret methods unavailable until a separately verified OS-secret implementation exists. Remote browser access to a backend launched by the desktop still uses the desktop broker and does not expose secrets remotely.

Electron 40 in the current repository exposes the synchronous `safeStorage` API; current Electron documentation recommends newer asynchronous operations for non-blocking access, key rotation, and temporary-unavailability handling. Moving the provider vault to that API requires a separately validated Electron upgrade. The first implementation must at minimum serialize synchronous vault access off latency-sensitive provider/event paths and surface cancellation or OS prompts cleanly.

The vault contract must not promise reliable zeroization of JavaScript strings, which are immutable and runtime-managed. It instead minimizes plaintext lifetime and copies: decrypt only in trusted desktop main for a single capability-scoped request, prefer owned byte buffers at native/process boundaries where they can be cleared, never cache plaintext, and destroy the one-use broker capability after launch or revocation. Encryption-at-rest does not make a secret safe once unnecessarily materialized in renderer or server memory.

Provider-specific implications:

- **Codex subscription/API login:** prefer Codex App Server's managed login methods in a distinct `CODEX_HOME` with `cli_auth_credentials_store = "keyring"`. Codex owns refresh and logout; Penkra records only the connection/profile binding.
- **Claude subscription in personal/development channels:** store one provider-generated long-lived subscription token per Connection in Penkra's static-secret backend and inject only `CLAUDE_CODE_OAUTH_TOKEN` into a runtime using Penkra-owned native conversation state. Expiry or revocation makes only that Connection unhealthy and requires explicit reauthorization; it must never fall through to keychain login. Availability remains controlled by the resolved authentication-method capability policy.
- **Claude Console API keys:** store the key through Penkra's static-secret backend and inject only `ANTHROPIC_API_KEY` after removing every higher-precedence Claude credential variable/source from the runtime profile.
- **OpenCode Go and static upstream providers:** store each API key through Penkra's static-secret backend and expose only the selected provider credential to the Connection server. For other OpenCode integrations that genuinely use OAuth, use a private connection profile with writable `auth.json`, because refresh tokens must be updated by OpenCode.

Recommended first-release resource mapping:

| Adapter authentication method                    | Connection credential boundary                                                    | Native conversation-state boundary                                                          | Explicitly excluded fallback                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Codex managed ChatGPT or API login               | One Connection-scoped `CODEX_HOME` and provider-owned keyring entry               | Penkra-owned Codex session/rollout state mounted into each isolated runtime profile         | Global `~/.codex`, `PATH` executable, copied `auth.json`, or experimental host-token mode              |
| Claude subscription, personal/development policy | One Penkra OS-secret reference containing a provider-generated long-lived token   | One Penkra-owned Claude native-state root used with the selected token injected per process | Global Keychain login, inherited API key, transcript reconstruction, or alpha mirror as sole authority |
| Claude API key                                   | One Penkra OS-secret reference                                                    | Same Penkra-owned Claude native-state root                                                  | Subscription/keychain credential or another API key found in the shell                                 |
| OpenCode Go/static provider                      | One Penkra OS-secret reference injected through the documented in-memory auth map | One Penkra-owned OpenCode database/state root under a synthetic home                        | Global `auth.json`, `~/.opencode`, project-discovered credential, or Homebrew/npm executable           |
| Future OpenCode refreshable OAuth                | One writable Connection-scoped private credential profile                         | Explicitly mounted Penkra-owned OpenCode database plus verified auxiliary native state      | Stale `OPENCODE_AUTH_CONTENT` after provider refresh                                                   |

The table describes adapter responsibilities, not special cases in shared orchestration. A new adapter can use another credential or state backend only by declaring it and passing the same isolation, checkpoint, resume, switch, revocation, and crash conformance suite.

Deleting a Connection is a credential-revocation workflow, not a row deletion alone: refuse while it owns an active runtime, invoke the adapter's logout/delete operation, verify the selected profile no longer authenticates, remove its isolated credential material, and only then tombstone metadata. Removing one Connection must not log out another Connection for the same provider.

### Research gate summary

Resolved strongly enough for architecture review:

- Connection, managed installation, native state, and live runtime are separate resources; account switching changes an explicit same-provider thread binding, not the provider or transcript.
- Transcript replay, inferred credentials, `PATH` executables, automatic failover, Sidechat, and cross-provider Handoff are excluded cleanly.
- Codex supports stable resume-by-ID across isolated homes when exact native state remains addressable; referenced absolute state paths require immutable state skeletons.
- Claude can select one injected OAuth token or API key from a shared Penkra-owned state root; Penkra must inject exactly one and scrub every competitor.
- OpenCode static credentials can be selected per process while sharing an explicit database/state root; first initialization requires a lease.
- Static secrets belong in a dedicated Electron-main encrypted vault and one-use broker, with Linux insecure backends failing closed.
- Provider support is adapter/manifest/conformance driven, and release-policy availability is derived rather than persisted as user-editable truth.

Real-account evidence completed:

- Codex ChatGPT A→B→A across distinct provider-reported identities, plus native tool and image items;
- Claude subscription A→B→A across operator-authorized tokens, native compaction, cache behavior, tool results, image input, and a separate subagent transcript directory;
- OpenCode Go A→B→A through the correct `opencode-go` provider and Go-included models, plus native tool and capability-gated image state;
- fail-closed Claude API-key selection when the selected Console account lacked credit, with successful recovery on the prior subscription Connection.

Remaining evidence gates:

- funded Claude API-key inference on the same native session (explicitly deferred by the operator on 2026-08-03; subscription-login validation is sufficient for the current design and architecture phase);
- interruption and application/provider crash recovery with real in-flight turns;
- explicit logout/revocation, expiry/refresh, quota exhaustion, and removal of an originating Connection while retained native state remains usable;
- tasks/plans/spilled outputs and any other auxiliary state not exercised by the tool/image/subagent probes;
- managed installation update N→N+1, rollback, and manifest-diff conformance using Penkra-owned binaries.

### Verified native-state manifest baseline

The manifest is adapter-versioned and provider-generation-specific. These are the minimum resources observed with current managed-source candidates; they are not permission to ignore future writes.

| Provider                          | Verified authoritative/required state                                                                                                                                                                          | Structured items proven                                                                                                                | Still unclassified or unproven                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex 0.146.0                     | Common `CODEX_SQLITE_HOME` databases plus the original absolute `CODEX_HOME/sessions` rollout path retained as an immutable state skeleton; `shell_snapshots` must remain eligible when a thread references it | user/assistant messages, reasoning, native function call/output, inline image input, resume-by-ID across real accounts                 | archived sessions/index, attachments outside inline images, goals, memories, generated-image/browser/computer-use/REPL artifacts, subagents, compaction, live crash |
| Claude Code 2.1.220 / SDK 0.3.207 | One Penkra-owned `CLAUDE_CONFIG_DIR`, especially `projects/<cwd-key>/<session-id>.jsonl` and `<session-id>/subagents/*`; same-root settings/policy metadata must be classified rather than copied blindly      | messages, manual compact boundary/summary, tool use/result, SDK image block, subagent JSONL/meta, cross-token resume                   | tasks, plans, spilled tool output, optional file history/checkpoints, debug/session-env/shell snapshots, live crash, funded API-key turn                            |
| OpenCode 1.18.10                  | Explicit common `OPENCODE_DB` plus the synthetic XDG data/state resources declared by the adapter; no `auth.json` for static Go keys                                                                           | messages/parts, tool part/result, `image/png` file part, model-capability rejection, cross-key resume, in-flight interruption recovery | snapshots/reversions, plan files, spilled tool output, child sessions, repository metadata, managed plugins/config, update-version skew                             |

Manifest ownership rules:

- A native-state generation owns every referenced path, including paths physically nested beneath the Connection profile that first created them. Connection deletion revokes credentials and mutable account configuration but cannot remove a referenced state skeleton.
- Inline structured data remains provider-owned; Penkra indexes/projects it for UI but does not recreate it from rendered transcript text.
- Companion paths are retained by opaque adapter manifest entries with content type, relative/absolute mount identity, durability/checkpoint class, and adapter schema version. Shared orchestration does not interpret them.
- Every managed provider update runs a write-set discovery fixture covering plain turns, tools, images/files, compaction, subagents/child sessions, interruption, rollback/reversion, and crash. Any new or relocated unclassified write blocks activation.
- Garbage collection requires zero thread/state/binding/transition/runtime/rollback references, a verified credential-independent state snapshot, and expiration of the operator-approved recovery window.

Explicitly deferred rather than guessed:

- generally distributed Claude subscription login pending provider-policy permission; personal/development policy may enable it;
- funded Claude Console API-key inference; the fail-closed credential-selection path was proven, while a billable model turn remains deferred rather than treated as passed;
- refreshable OpenCode OAuth and enterprise/cloud Claude methods until their own adapter backends pass conformance;
- additional providers until they implement the same generic contract;
- any unsupported cross-account native resume capability. It remains unavailable rather than falling back to projected transcript text.

### Draft durable model for review

Names remain provisional, but the responsibilities must stay separate:

- `provider_installations`: immutable generation ID, provider kind, version, platform/architecture, absolute executable path, source URL/channel, verified digest/signature result, adapter/protocol version, health state, installed/activated timestamps, and retirement state.
- `provider_connections`: immutable Connection ID, provider kind, and authentication-method ID; user label; opaque credential/profile reference; non-secret provider account/workspace identity; last observed health; and lifecycle timestamps. No executable path, native thread/session ID, or persisted release-policy truth. Current availability is resolved from adapter support, trusted policy, platform prerequisites, secret-backend health, installation health, and Connection health whenever the server exposes or uses it.
- `thread_provider_states`: one started thread's immutable provider kind, opaque native state locator/version, provider session ID where non-secret, checkpoint generation/status, and last verified resume timestamp. No credential material and no transcript reconstruction.
- `thread_connection_bindings`: current Connection ID, installation generation ID, binding revision, and transition status for a started thread. This is the explicit answer to “which account and executable will the next turn use?”
- `provider_connection_transitions`: append-only old/new Connection IDs, old/new installation generations, phase, reason (`manual_switch`, `login_repair`, `installation_activation`, or `rollback`), sanitized provider error classification, timestamps, and recovery outcome.
- `space_provider_defaults`: optional default Connection by provider for new drafts in a Space. Defaults never rewrite existing thread bindings.

Folder-level Connection defaults are not part of the first release. A Space default can select the usual Connection for a new draft; a draft can override it. Once the first turn starts, the provider is fixed and the chosen Connection becomes the initial explicit thread binding. Later switching is manual and same-provider only.

Required persistence invariants:

- `provider_kind` and `authentication_method_id` are immutable after Connection creation; a started thread's provider is immutable after its first accepted turn.
- Availability is computed, never stored as release-policy truth. Persist only observations such as last health check and its reason; re-evaluate support, policy, secret backend, managed installation, and credential health at every authorization boundary.
- A thread has exactly one current binding. Binding changes use optimistic revision matching, and a partial unique constraint permits at most one unsettled transition lease per thread.
- A Connection, thread state, binding, Space default, and transition must reference the same provider kind. Because cross-table equality is awkward to express with ordinary foreign keys, one domain transaction validates it and database triggers/constraint tests defend every write path. Provider mismatch is rejected before runtime effects.
- `space_provider_defaults` is unique by `(space_id, provider_kind)` and references an active Connection of that provider. Archiving/deleting a Space or disabling a Connection never selects a replacement.
- Opaque adapter payloads always carry adapter ID and schema version. Unknown versions fail closed and remain preservable for rollback; shared migrations do not parse or rewrite them.
- Secret-vault records are not cascade-deleted with metadata. Connection deletion first completes and verifies adapter revocation, then deletes the isolated secret/profile, then tombstones the Connection in a recoverable transaction record.
- Native-state generations and installation generations are immutable once referenced. Garbage collection requires a complete reference proof and cannot run while a transition, live runtime, rollback window, or recoverable migration snapshot references them.

### Draft Connection-switch state machine for review

Only one transition lease may exist for a thread. The switch control is unavailable while a provider turn, approval, compaction, fork, import, or another transition is unsettled; the user may explicitly cancel/settle the active operation first.

1. **Validate** — confirm thread and target Connection provider kinds match, the target authentication method is supported and enabled by the running server policy, target credentials are healthy enough to attempt login, target installation generation is verified, and native resume is declared supported. No runtime is stopped yet.
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

### Clean-cut migration for this installation

The existing installation is the only user data in scope, so migration should be exact and intentionally breaking rather than compatibility-driven:

1. Read the active Dev and production installations through Penkra's supported thread/settings/runtime surfaces first. Use direct SQLite inspection only for fields those surfaces explicitly do not expose, and record which database file is actually opened before any migration count.
2. Inventory started threads by immutable provider, native session ID/state locator, current runtime installation, and Sidechat/Handoff markers. Do not infer a provider or account from a title, model name, folder path, last-opened state, or shell credential.
3. Install verified Penkra-managed generations for the three initial adapters before changing any thread binding. The existing Homebrew/npm/global binaries are migration sources only and are never runtime fallbacks.
4. Create Connections through explicit provider verification. Codex managed profiles require fresh provider login in their new `CODEX_HOME`; Claude subscription Connections require a fresh provider-generated token; static API keys are entered/imported into the OS-secret backend. Do not scrape or clone global keychain entries.
5. Present the exact provider-to-Connection mapping for operator confirmation. Bind existing threads only to the chosen Connection of the same provider. If no verified Connection exists, keep the thread and native state but mark it unavailable until the operator chooses one; never select “the first,” “last used,” or a global login.
6. Move/copy provider-native conversation state into its adapter-owned Penkra state root using provider-native import or a versioned, verified state migration. Prove native resume without a model turn before committing each binding. Retain a recoverable pre-migration snapshot until manual QA is approved.
7. Remove Sidechat and cross-provider Handoff records/columns/commands as the approved clean cut. Log only sanitized counts. Do not convert either feature into ordinary threads through reconstructed context.
8. Atomically advance the schema/data migration only after every retained thread is either natively resumable or explicitly recorded as unavailable with its original state preserved. A failed migration leaves the old application/database generation untouched.

There is no legacy runtime compatibility mode after activation: no global credentials, external executable selection, inferred Connection, transcript bootstrap, Sidechat, or cross-provider Handoff path remains callable.

## Runtime installation and update boundary

Connections must not own their own provider binary, and a provider binary must not imply an account. Managed installations are the approved default. The OpenCode dual-install finding demonstrates why:

- Penkra-managed installations should live under Penkra's data directory, use an absolute executable path, download/install into a staging generation, verify version/health, then atomically activate the generation only when no incompatible live runtime owns it.
- Homebrew, NVM/npm-global, and other external installations may be detected only for an explicit migration/import flow. Penkra must not silently run `brew upgrade`, mutate a user's global npm tree, or continue choosing a runtime from `PATH` after migration.
- For this single-user clean cut, install and select Penkra-managed generations for Codex, Claude Code, and OpenCode. Existing external copies remain outside Penkra and are not compatibility fallbacks.
- Update checks, update installation, runtime launch, rollback, and QA must all reference the same installation ID/path. A bare command name is insufficient.

Managed does not automatically mean legally redistributing a bundled binary. The provider adapter may install an official package on demand into Penkra-owned storage. Before implementation, research must confirm each provider's official distribution channel, license/terms, integrity metadata, authentication bootstrap, platform/architecture matrix, and downgrade availability.

### Managed installation findings

| Provider    | Recommended Penkra-managed source                                                                                                                                                           | Integrity and rollback evidence                                                                                                                                                                                                                                                  | Runtime update control                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | Resolve a stable version through OpenAI's official release metadata and download the exact platform archive into a new Penkra generation. Do not invoke Homebrew/npm or select from `PATH`. | Official releases provide platform archives, `codex-package_SHA256SUMS`, and GitHub release SHA256 digests. Exact older release assets remain addressable, so Penkra can retain N while staging N+1.                                                                             | Disable in-app updates through managed requirements where applicable; Penkra alone activates generations.                                                        |
| Claude Code | Download the exact native binary from Anthropic's documented versioned release bucket into a Penkra generation. A Penkra-owned launcher may select a pinned version.                        | Every current release has a SHA256 manifest; releases from 2.1.89 onward have a detached GPG signature. macOS and Windows binaries also have native code signatures. The installer accepts exact versions, and Anthropic documents retained version files with custom launchers. | Set `DISABLE_UPDATES=1` for managed runtimes, not merely `DISABLE_AUTOUPDATER`, so neither background nor manual provider self-update can mutate the generation. |
| OpenCode    | Download the exact versioned platform archive from the official `anomalyco/opencode` GitHub release into a Penkra generation.                                                               | GitHub release metadata exposes a SHA256 digest for each archive, and older tagged assets are directly addressable.                                                                                                                                                              | Set `OPENCODE_DISABLE_AUTOUPDATE=1` and managed `autoupdate: false`; never run `opencode upgrade` inside an active generation.                                   |

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

## Required validation matrix before architecture approval

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
- application restart during each transition phase;
- a globally logged-in provider and globally exported credentials are present while Penkra launches each isolated Connection; provider-reported identity/usage must prove the selected Connection won;
- stale/malicious client requests attempt to create, log in, launch, default, or switch to a disabled authentication method; every server entry point must reject them;
- an application policy update changes an existing authentication method from enabled to disabled, including a Space default and started thread already bound to it;
- re-enable the preserved method and health-check its Connection without automatic thread rebinding;
- expired/revoked subscription token and API key, with another healthy same-provider Connection present; no automatic failover may occur;
- Connection labels are duplicated or renamed; selection must remain ID-based;
- delete one Connection while another Connection for the same provider is active, proving credential revocation and profile cleanup are isolated.
- create a Codex thread under A, switch to B, remove A's credential/profile while preserving the declared native-state generation, restart, and prove B can still resume from the exact checkpoint; this specifically detects absolute rollout paths trapped inside A.
- start two OpenCode runtimes simultaneously against a brand-new native-state generation and prove the adapter's initialization lease prevents the observed first-open `database is locked` race; then repeat concurrent steady-state access and crash recovery.
- make the desktop secret broker unavailable before launch, during a one-use fetch, and after provider spawn; every case must produce a stable fail-closed state without reusing a stale plaintext value.
- on Linux fixtures, report `basic_text`, `unknown`, and unavailable safe-storage backends and prove static-secret methods are unavailable end to end while provider-native methods remain independent.
- inject recognizable sentinel secrets into every static method and inspect the provider vault file, application databases, renderer storage, RPC payload capture, process arguments, logs, crash dumps, screenshots, and exported diagnostics; plaintext must be absent everywhere except the selected child environment or documented in-memory provider input for the lifetime of that runtime.
- restart the desktop main and backend independently, proving secret-broker capabilities cannot be replayed and no plaintext secret cache is required for recovery.

Each run must capture sanitized structured provider events, Penkra orchestration events, connection ID, provider session ID, transition phase, exact failure classification, and visual/manual QA outcome. Credentials, authorization headers, raw tokens, and sensitive tool output must never enter logs.

### Observability and fault-injection contract

Every provider runtime and Connection transition receives a correlation ID. Structured diagnostics should include only:

- adapter/provider kind and adapter version;
- managed installation generation and absolute executable identity represented by a stable internal ID in ordinary logs;
- Connection ID, authentication-method ID, and sanitized availability/health classification;
- Penkra thread ID, opaque native-state generation, provider session ID when the provider documents it as non-secret, binding revision, and transition phase;
- process start/stop reason, checkpoint/resume result, provider error category, and timing;
- provider-reported account/workspace fingerprint stored as a keyed local diagnostic HMAC when needed to prove isolation, never a raw or unsalted hash of an email/account ID, token, organization secret, or authorization header;
- cache/token usage fields only where the provider already reports them and only after confirming they contain no prompt/tool content.

Environment logging is deny-by-default: record the names of credential variables that were scrubbed or selected, never their values or serialized auth maps. Provider stdout/stderr must pass a secret redactor before persistence, with an in-memory raw stream available only to the running protocol parser. Redaction is defense in depth; tests must inject recognizable sentinel secrets and prove they do not appear in logs, database events, crash reports, screenshots, or exported diagnostics.

Deterministic fault points are required after every durable phase in the switch state machine and installer activation protocol. The QA harness must terminate the app/provider process at each point, restart Penkra, and assert the documented phase-driven recovery. Random stress complements these cases but cannot replace them.

Manual QA must start a fresh isolated Penkra (Dev) instance and visibly exercise Connection creation, naming, default selection, new-thread binding, same-provider switching, failure/no-fallback behavior, disabled-method behavior, update/restart, and Connection management for each supported authentication method. The operator-provided real accounts/keys are required for the final identity, quota, refresh/expiry, compaction, and cache observations; synthetic credentials cannot establish those claims.

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
- Claude Code environment variables: <https://code.claude.com/docs/en/env-vars>
- Claude Code application-data layout: <https://code.claude.com/docs/en/claude-directory>
- Electron safeStorage: <https://www.electronjs.org/docs/latest/api/safe-storage>
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
