# Provider Connections Research

Status: research in progress. This document records evidence; it is not an approved architecture or implementation plan.

## Rules for this investigation

- Prefer stable provider-native session operations over reconstructed prompts.
- Separate credential isolation, configuration isolation, process isolation, and conversation-state portability. They are not interchangeable.
- Mark every finding as documented, observed, inferred, or unresolved.
- Do not treat a visible Penkra transcript as equivalent to provider-visible context.
- Do not silently truncate, summarize, replay, or discard context.
- Do not begin Pencil or implementation work until this research is reviewed.

## Local versions observed on 2026-08-03

| Runtime     | Command-reported version                                         | Notes                                                                                          |
| ----------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Codex       | `codex-cli 0.146.0`                                              | Installed at `/opt/homebrew/bin/codex` during the initial probe.                               |
| Claude Code | `2.1.220`                                                        | Installed at `~/.local/bin/claude`.                                                            |
| OpenCode    | CLI reported `1.18.10`; isolated server health reported `1.18.5` | The executable resolution/version mismatch requires investigation before version-sensitive QA. |

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

Unresolved:

- Whether a stored rollout can be resumed under another independently authenticated `CODEX_HOME` through a stable supported operation.
- Whether experimental history/path resume preserves every compaction, tool, reasoning, goal, approval, and instruction-state semantic needed by Penkra.
- Whether host-managed ChatGPT tokens can safely provide per-process accounts without mutating shared credential state.
- Concurrency guarantees if multiple app-server processes reference shared session state.

### Claude Code / Claude Agent SDK

Documented:

- Sessions are structured JSONL transcripts and resume by session ID.
- The SDK exposes native session forking with UUID remapping and parent-chain preservation.
- `SessionStore` mirrors the exact JSON-safe transcript entries and can materialize them for resume on another process or host.
- `SessionStore.load()` requires entries deep-equal to those appended; byte-identical JSON serialization is unnecessary.
- Subagent transcript restoration requires `listSubkeys()`.
- `CLAUDE_CODE_OAUTH_TOKEN` overrides keychain credentials for SDK/automation use.
- `CLAUDE_CONFIG_DIR` changes settings, credentials, session history, and plugin storage together.

Observed in Penkra:

- The current Claude adapter uses the SDK's native `resume` option but does not provide a Penkra-owned `SessionStore`.
- The current adapter passes one resolved environment to the SDK subprocess. This is the natural insertion point for a connection-scoped credential environment.

Unresolved:

- Cross-account continuation of the same exact native session, including server-side cache behavior and account authorization constraints.
- Required secure storage and refresh lifecycle for multiple subscription OAuth tokens.
- Exact behavior of compacted, subagent-heavy, attachment-heavy, and interrupted sessions when restored through a Penkra-owned store.

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

Unresolved:

- Export/import fidelity for tool calls, tool outputs, binary/file parts, summaries, reversions, permissions, child sessions, and incomplete turns.
- Whether importing an already-present session is idempotent or can conflict with local state.
- Whether OpenCode Go/subscription OAuth credentials can be selected per process without coupling session storage to the credential database.
- Why the installed CLI and spawned server reported different patch versions.

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

No removal is approved yet.

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
- Claude Code sessions: <https://code.claude.com/docs/en/sessions>
- Claude Code authentication: <https://code.claude.com/docs/en/team>
- Claude Agent SDK session storage: <https://code.claude.com/docs/en/agent-sdk/session-storage>
- OpenCode server: <https://opencode.ai/docs/server>
- OpenCode SDK: <https://opencode.ai/docs/sdk>
- OpenCode providers: <https://opencode.ai/docs/providers>
- ACP session resume: <https://agentclientprotocol.com/announcements/session-resume-stabilized>
- Pi SDK: <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md>
- Pi compaction: <https://pi.dev/docs/latest/compaction>
