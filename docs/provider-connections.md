# Provider Connections

Penkra owns the provider executable, each Connection's credential scope,
and each Thread's native provider state. A Connection is an account or key. An
anonymous model route, such as an OpenCode Zen free model, is not a Connection.

## Invariants

1. Managed ChatGPT (Codex runtime), Claude, and OpenCode launches use only Penkra's verified
   installation. They never fall through to `PATH`, Homebrew, npm, a global
   provider profile, or ambient provider credentials.
2. A child process receives only the selected Connection's credential and
   Connection-scoped provider state. Adding another provider is manifest work,
   not a new credential-routing special case.
3. A Thread fixes its harness after its first message. Its model and Connection
   may change only through an explicit selection on a later sent message.
4. A selection in the composer is pending UI state. The durable binding changes
   only after the next message successfully creates or resumes exact native
   state under that selection.
5. A failed switch leaves the prior binding and transcript unchanged. There is
   no automatic account switching, transcript reconstruction, or best-effort
   native-session guess.
6. A successful Connection change and model change are recorded as
   ordinary Thread activity. Earlier messages are never relabeled.
7. Disconnecting a Connection removes its usable credential or signs out its
   isolated profile, then terminates the durable Connection record. Existing
   Thread bindings remain exact and fail on their next send until the user
   explicitly chooses an available Connection.
8. The composer remembers the last explicitly selected Connection per harness.
   New Threads reuse that preference when it can authorize the selected model;
   otherwise they use the first compatible active Connection.
9. An anonymous model route is selected by the model itself and never creates or
   mutates a Connection preference.

## Durable shape

- `provider_installations` records immutable managed executable generations.
- `provider_connections` records accounts and keys without storing the
  secret itself.
- `provider_native_state_generations` owns isolated native state.
- `thread_harness_states` and `thread_runtime_bindings` bind a Thread to
  exact native state, installation, Connection, internal provider, and model.
- Operation journals make credential creation, login, switching, forking, and
  native-state deletion recoverable across restart.

Static secrets live in Desktop secure storage. Provider-managed logins live in
Connection-scoped profile directories. ChatGPT's Codex runtime and OpenCode Thread state use
separate generation roots. Claude's native contract keeps authentication and
sessions in one config root, so its whole config root is Connection-scoped and
only the exact session plus session-owned auxiliary directories are copied into
the selected target Connection profile. A switch otherwise materializes only
the matching Codex rollout or OpenCode conversation database and declared state
collections. Profile settings and authentication files are never cloned.

The initial declared authentication methods are:

- Claude: Claude account sign-in, or an Anthropic API key supplied only as
  `ANTHROPIC_API_KEY` to that Connection's isolated runtime.
- ChatGPT: ChatGPT account sign-in, or an OpenAI Platform API key imported by
  Codex's native `login --with-api-key` flow into that Connection's isolated
  profile. A bare ambient `OPENAI_API_KEY` is not treated as Codex login state.
- OpenCode: OpenCode Zen or OpenCode Go API keys routed only to the matching
  internal provider. Anonymous Zen free access remains a route, not a Connection.

The removed pre-release Claude setup-token backend has one migration path: an
exact durable termination operation removes its encrypted secret and retires the
Connection. It is not recognized by the runtime after that migration.

## Selection flow

For a new Thread, the composer resolves one exact route from the selected model:
the last compatible Connection selected in the composer, the first compatible
active Connection, or an explicitly provider-declared anonymous route. The
first send verifies the managed installation, route, credential backend, and
live model catalog before committing the initial binding.

For a started Thread, choosing a model or Connection does not interrupt the
current turn and does not change durable state. The next send carries the exact
selection and current binding revision. A queued send journals the requested
switch and waits for the active turn to settle naturally; a steering send
interrupts it. Penkra then materializes or opens target native state, verifies
its native identity, and atomically commits the new binding, activity entry, and
turn admission.

## Product surface

- Settings > Agents owns installation readiness and Connections.
- The composer owns a Connection control beside the model control and remembers
  the last explicit selection per harness. Connection switching is not nested
  inside model selection.
- Account Connections show a user glyph. Opening their popup loads the
  provider-reported usage windows for the exact isolated Connection profile;
  usage is never prefetched or refreshed in the background.
- API-key Connections show a key glyph instead of the account glyph. Their
  popup explains that usage is unavailable in Penkra and opens the provider's
  usage dashboard through the default system URL handler.
- Codex and Claude declare account and API-key Connections. OpenCode declares
  API-key Connections only.
- Onboarding embeds the same Agents setup surface and remains skippable because
  OpenCode can expose provider-declared free models without a Connection.
- OpenCode's anonymous model list comes from its live managed inventory. Penkra
  accepts the provider's explicit free flag or authoritative zero input/output
  pricing; model names and suffixes are never used to guess eligibility.
- Signed-out and disconnected Connections are unavailable, not recoverable
  through a second sign-in UI in the initial version.

## Operator QA gate

Run this matrix in one numbered Penkra Dev installation and retain the exact
Thread ids, Connection ids, operation journal rows, native identities, and
visible transcript results. A case passes only when both the UI and durable
records agree; a plausible response by itself is not proof of routing.

1. Start from a fresh Penkra account with no Connections. Only OpenCode and its
   live, explicitly free anonymous Zen models are usable. Claude and ChatGPT do
   not appear as available harnesses. A paid or non-free OpenCode route requires
   its matching Connection.
2. Add one Connection through each supported authentication method being
   released. Verify the managed installation and isolated profile used by the
   launched child, the provider-returned account email or credential suffix,
   and the resulting composer selection. Never inspect or print a secret.
3. Add a second account for the same harness. Start separate Threads on both,
   close and reopen Penkra, log out and back into Penkra, and verify each Thread
   resumes its original native identity and Connection.
4. For an idle started Thread, switch models within a harness and then switch
   Connections. Each switch commits only on its sent message, increments the
   binding revision once, preserves earlier transcript labels, and records the
   matching activity. A Connection switch creates a new exact native-state
   generation; a model-only switch does not invent one.
5. During a running turn, send a normal follow-up with another Connection. The
   current turn finishes naturally, the follow-up waits, and the settled source
   revision is pinned before the switch verifies and commits.
6. During a running turn, send a steering follow-up with another Connection.
   The current turn is interrupted, its exact settled source revision is pinned,
   and the steered message runs only after the new Connection commits.
7. Disconnect the Connection bound to an existing Thread. Its next send fails
   with the standard unavailable-Connection error and does not mutate the
   binding or transcript. Explicitly select a remaining Connection and verify
   the next send switches successfully. Re-add the disconnected provider as a
   new Connection; no retired identity is revived.
8. Save a Connection in the composer, switch Spaces, and start a new Thread.
   Verify the saved compatible Connection remains selected. Disconnect it and
   verify a new Thread uses the first compatible active Connection while
   existing Thread bindings remain unchanged.
9. Interrupt Penkra once in each open operation phase: Connection login,
   credential creation, Connection termination, queued/steered switch, and
   native-state materialization. Restart and verify the same journal either
   resumes to one committed result or ends in one explicit failure without a
   duplicate Connection, message, transcript event, or native generation.
10. Update each managed harness from an older verified generation. New Threads
    use the newly active installation; existing Threads continue on their exact
    retained installation generation. Both paths must work without reading
    `PATH`, Homebrew/npm state, global profiles, or ambient credentials.
