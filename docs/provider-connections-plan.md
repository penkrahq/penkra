# Provider Connections Delivery Plan

Status: pre-implementation. Product decisions are approved, the pre-design native-switch probes have passed, provider research is recorded in `provider-connections-research.md`, and code remains blocked until the current Pencil designs are explicitly approved as final.

## Non-negotiable product contract

- A started thread keeps one immutable harness: Codex, Claude, or OpenCode in the first release.
- The user may manually change a Connection, model, or OpenCode internal provider only when the same harness adapter has proven exact native continuation for that transition.
- There is no transcript reconstruction, cross-harness switch, automatic failover, inferred credential, global executable fallback, or global credential fallback.
- Anonymous OpenCode Zen access is represented by a null Connection. Its usable models come only from the effective managed-runtime catalog.
- Sign out, disconnect, credential rejection, expiry, and removal terminate the Connection ID. A later login always creates a new ID. There is no reconnect or replace-key flow.
- Threads retain a terminated historical binding and return the ordinary unavailable-Connection error. Space defaults alone fall back to the most recently created usable same-harness Connection, with immutable ID as the stable tie-breaker.
- Sidechat and Penkra's cross-provider Handoff are removed as clean cuts.
- API-key Connection names are required. Provider identity is stored only when the provider supplies a verified stable identifier; labels and secrets are never identity-matching inputs.
- Harness and model visibility is capability-driven. Unsupported or policy-disabled surfaces fail closed.

## Phase 0 — Close pre-design evidence

Deliverables:

- Keep the assumption ledger in `provider-connections-research.md` current.
- Preserve the completed Claude model A→B→A evidence on one exact native session.
- Classify every remaining research item as one of: design blocker, implementation conformance gate, final real-account QA, or explicitly deferred.
- Confirm the Pencil editing/inspection capability is available; never substitute Figma or filesystem parsing for the `.pen` authority.

Exit gate:

- No unresolved behavior may be implemented as a fallback or heuristic.
- Any unresolved product behavior is returned to the operator as a decision before Pencil changes.

## Phase 1 — Finalize Pencil only

Deliverables:

- Remove Sidechat, cross-provider Handoff, `Sign in again`, replacement-key, and separate `Needs attention` surfaces.
- Finish new-install setup, Connection management, required API-key naming, disabled harness/method states, Space defaults, draft selection, started-thread selection, anonymous OpenCode, ordinary unavailable-Connection error, and terminal disconnect states.
- Keep user copy non-technical: no CLI, shell, process, executable, credential store, or native-state terminology in ordinary UI.
- Reconcile components, variants, stories, and screens with the existing Pencil hierarchy rules before adding screens.
- Record the intended visibility and interaction state for every control, including empty/no-Connection states.

Exit gate:

- Present the finalized Pencil changes to the operator.
- Do not begin Phase 2 until the operator explicitly approves that exact design state as final.

## Phase 2 — Remove incompatible legacy behavior

Deliverables:

- Remove Sidechat contracts, projections, commands, UI, prompt boundaries, and live schema fields.
- Remove cross-provider Handoff contracts, projections, commands, UI, imported-message metadata, and `handoff_context` reconstruction.
- Remove projected-transcript bootstrap from retained providers. Native resume failure becomes an explicit unavailable/corrupt-state error.
- Rename any unrelated Git workspace operation still called handoff so it cannot be confused with provider continuity.

Validity gate:

- Inventory this installation before migration. Discard only the Sidechat/Handoff records explicitly authorized by the operator.
- Prove ordinary threads, provider-native forks/imports, message editing/rollback, and restart paths do not call transcript reconstruction.

## Phase 3 — Managed installation substrate

Deliverables:

- Add harness-neutral installation generations with immutable executable paths, source metadata, integrity result, adapter/protocol version, and activation state.
- Implement stage, verify, probe, activate, retain, roll back, and retire operations.
- Install official Codex, Claude, and OpenCode artifacts into Penkra-owned generations; never update Homebrew/npm/global installations.
- Disable provider self-update inside managed generations.

Validity gate:

- For each harness, exercise generation N, N+1, failed N+1, activation, live-thread pinning, restart/resume, rollback, and process cleanup.
- A write-set or protocol change not classified by the adapter blocks activation.

## Phase 4 — Connection identity and secret boundary

Deliverables:

- Add immutable Connection IDs, harness/authentication target/method metadata, required key labels, lifecycle state, and opaque credential references.
- Add the desktop-main encrypted provider vault and one-use secret broker for static keys/tokens.
- Add isolated provider-owned login profiles where refresh must remain provider-owned.
- Scrub all unselected credential variables, auth files, inherited logins, and global configuration before launch.
- Implement terminal disconnect/removal and tombstoning; a later login creates a new ID.

Validity gate:

- Sentinel secrets are absent from SQLite, renderer storage, RPC capture, logs, diagnostics, screenshots, crash output, and process arguments.
- Removing one Connection does not alter another Connection for the same harness.
- Unavailable safe storage disables static-secret methods end to end.

## Phase 5 — Native state, bindings, and migration

Deliverables:

- Add immutable thread harness state, versioned native-state generations, nullable runtime bindings, append-only transitions, and Space Connection defaults.
- Keep Connection credentials, native conversation state, managed installations, and live runtimes as separate resources.
- Migrate this installation through explicit operator-confirmed same-harness Connection mapping and verified provider-native resume.
- Preserve a recoverable pre-migration snapshot until final manual QA is approved.

Validity gate:

- Every retained thread is either proven natively resumable or explicitly unavailable with its original state preserved.
- No title, model name, path, last-used state, shell login, or record order is used to infer a binding.
- Space fallback is deterministic; existing thread bindings never change automatically.

## Phase 6 — Adapter conformance and transition engine

Deliverables:

- Implement the same lifecycle-shaped adapter contract for Codex, Claude, and OpenCode: installation, authentication, native state, runtime, catalog, and telemetry.
- Implement the persisted validate/fence/checkpoint/quiesce/probe/commit/retire state machine.
- Permit only adapter-declared same-harness model/internal-provider/Connection transitions.
- Append a visible `Connection changed to …` thread event only after commit.

Validity gate:

- Inject a crash after every durable transition phase and verify phase-driven recovery.
- Test compaction, tools, images/files, subagents/child sessions, interruptions, approval waits, concurrent Connections, corruption, logout, expiry, quota errors, and catalog retirement.
- No recovery path supplies projected transcript text.

## Phase 7 — Implement the approved UI

Deliverables:

- Implement only the approved Pencil screens and component hierarchy.
- Show only harnesses with usable capabilities, plus explicitly designed disabled states.
- Implement setup, management, Space defaults, draft selection, started-thread manual switching, anonymous OpenCode, and terminal removal behavior.
- Keep model and Connection choices independent where the harness exposes them independently.

Validity gate:

- Component/state coverage maps back to Pencil nodes and variants.
- Keyboard, pointer, hover, focus, tooltip, loading, error, empty, disabled, and narrow/wide layout states are manually inspected.

## Phase 8 — Cleanup and hardening

Deliverables:

- Remove dead schemas, migrations-in-progress shims, flags, compatibility paths, provider-name branches in shared orchestration, duplicate catalog logic, and obsolete UI.
- Centralize redaction, availability resolution, deterministic fallback, installation identity, and transition recovery.
- Review database constraints, reference ownership, cleanup safety, timeouts, cancellation, process fencing, and observability cardinality.

Exit gate:

- A fresh search finds no callable legacy transcript bootstrap, Sidechat, cross-provider Handoff, global credential fallback, `PATH` runtime selection, reconnect, or replace-key route.

## Phase 9 — Final verification and operator-assisted QA

Automated validity suites:

- Migration and constraint tests.
- Adapter conformance and fault injection.
- Managed update/rollback fixtures.
- Secret-leak sentinels and environment precedence.
- Projection/restart/recovery and catalog-change tests.

Fresh Penkra (Dev) manual QA:

- Clean installation and existing-install migration.
- Create user, restart, sign in to each available harness, create named key Connections, and verify persistence across logout/login and app restart.
- Start and continue threads, switch same-harness Connections/models/internal providers, compact, use tools/files, interrupt, close/reopen, and restart.
- Disconnect a Connection, observe the ordinary thread error, verify Space fallback, add a new Connection with a new ID, and switch manually.
- Verify anonymous OpenCode, Go models, free-model errors, disabled states, managed updates, rollback, and no interference from global provider installations/logins.

Completion gate:

- Start a fresh isolated Penkra (Dev) instance and record the exact manually exercised flows and results, as required by `AGENTS.md`.
- Do not commit or declare completion if an affected flow could not be manually exercised.

## Operator touchpoints

The work should stop for operator input only at these boundaries:

1. Restoring Pencil inspection/editing capability for the authoritative `.pen` file.
2. Product decisions revealed by a failed validity assumption.
3. Review and explicit approval of the finalized Pencil state.
4. Explicit confirmation of the existing-thread-to-Connection migration mapping.
5. Interactive provider login/key entry during final real-account QA.

The funded Claude API-key inference is explicitly deferred and is not a hidden completion requirement.
