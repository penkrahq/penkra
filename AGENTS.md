# AGENTS.md

## Documentation Audiences

- `docs/app-development.md` is the public App-author contract. Do not put Penkra repository setup,
  numbered Dev launchers, localhost services, internal seeds, product QA, deployment, or desktop
  release procedures there.
- `docs/app-development-internals.md` and the rest of the repository documentation are for Penkra
  contributors and operators. Keep development/production routing, sideloading, testing, QA,
  migrations, deployments, and releases explicit there.
- See `docs/README.md` for the documentation map. Never use internal desktop flavor as shorthand for
  registry environment; report the configured account-service target directly.

## Task Completion Requirements

- Before committing changes or declaring a task complete, start a fresh Penkra Dev instance and perform manual QA in the desktop app for the affected user flows. Automated tests, builds, browser-only checks, or inspecting an already-running instance do not replace this requirement.
- Record what was manually exercised and its result in the final handoff. If Penkra Dev cannot be started or a relevant flow cannot be exercised, report the task as not fully validated instead of silently treating it as complete.
- Do not run `bun fmt`, `bun lint`, or `bun typecheck` unless the user explicitly asks for them in the current conversation.
- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- Treat `bun fmt`, `bun lint`, and `bun typecheck` as heavyweight workspace checks: bundle them into one final verification pass per task whenever possible, and avoid rerunning the full set repeatedly during iteration.
- If a user asks for a small follow-up right after a recent full verification pass, prefer no rerun or the smallest reasonable re-check unless the user explicitly asks for full validation again.
- If the user asks to focus on code only, do not run `bun fmt`, `bun lint`, or `bun typecheck` automatically. In that mode, make the code changes first and only run verification if the user explicitly asks for it.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).

## Penkra Dev Thread Boundary

- A message sent into a Penkra Dev Thread must be a realistic request that an ordinary user would make about the product, an App, or work they want the Thread's agent to perform. This applies to every App and product area, not only Canvas.
- Do not send supervising-developer instructions into a Thread. Platform architecture, harness behavior, environment variables, sideload registration, process startup or restart, repository management, release mechanics, and test orchestration belong to the supervising developer working directly in the relevant repository.
- When a Thread is used to verify agent-driven App development, describe the desired user-visible behavior in normal product language. Let the Thread's agent discover the implementation. Do not feed it hidden infrastructure steps or make it responsible for preparing its own test harness.
- Keep the two evidence layers distinct: the Thread demonstrates that an agent can handle the normal user request, while the supervising developer establishes the clean runtime, loads the development App, observes the UI, and verifies that the result actually works.

## Version Authority

- Never choose, infer, bump, reset, tag, or publish a Penkra version unless the user explicitly approves the exact version in the current conversation.
- Instructions such as “release,” “clean cut,” “major change,” or “proceed” do not authorize a version change.
- Keep existing package and lockfile versions unchanged until the exact version is approved.
- Before creating or pushing a version tag or publishing a GitHub Release, restate the exact approved version and verify that package manifests, the lockfile, tag, artifact metadata, and release title all match it.
- A Penkra version applies only to the desktop product packages and release artifacts in this repository. It does not select, imply, bump, tag, publish, or coordinate the version of any registry App or backend deployment.
- Registry Apps have independent versions in their own `penkra-app.json` manifests and are published independently. Their `compatibility.penkra` range is the only version relationship to the desktop product.
- The Penkra backend is deployed independently and does not inherit the desktop version. Coordinate deployment order only when a desktop change actually depends on a backend contract change; never treat that operational dependency as shared version authority.

## Project Snapshot

Penkra is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Model Selection

Rankings, higher = better. Cost reflects what I actually pay (OpenAI is near-free for me due to a deal), not list price. Intelligence is how hard a problem you can hand the model unsupervised. Taste covers UI/UX, code quality, API design, and copy.

| model       | cost | intelligence | taste |
| ----------- | ---- | ------------ | ----- |
| gpt-5.6-sol | 9    | 8            | 5     |
| sonnet-5    | 5    | 5            | 7     |
| opus-4.8    | 4    | 7            | 8     |
| fable-5     | 2    | 9            | 9     |

How to apply:

- These are defaults, not limits. You have standing permission to override them: if a cheaper model's output doesn't meet the bar, rerun or redo the work with a smarter model without asking. Judge the output, not the price tag. Escalating costs less than shipping mediocre work.
- Cost is a tie-breaker only; when axes conflict for anything that ships, intelligence > taste > cost.
- Don't let cost prevent you from using the right model for the job. Instead, take advantage of cheaper options to get more information and try things before moving the work to a more expensive option.
- Bulk/mechanical work (clear-spec implementation, data analysis, migrations): gpt-5.6-sol — it's effectively free.
- Anything user-facing (UI, copy, API design) needs taste ≥ 7.
- Reviews of plans/implementations: fable-5 or opus-4.8, optionally gpt-5.6-sol as an extra independent perspective.
- Never use Haiku.
- Mechanics: gpt-5.6-sol is only reachable through the Codex CLI — `codex exec` / `codex review` (my `~/.codex/config.toml` defaults to gpt-5.6-sol). Use the codex-implementation, codex-review, and codex-computer-use skills; for work they don't cover (investigation, data analysis), run `codex exec -s read-only` directly with a self-contained prompt.
- Claude models (sonnet-5, opus-4.8, fable-5) run via the Agent/Workflow model parameter.

Using gpt-5.5 inside workflows and subagents (the model parameter only takes Claude models, so use a wrapper):

- Spawn a thin Claude wrapper agent with `model: 'sonnet', effort: 'low'` whose prompt instructs it to write a self-contained codex prompt, run `codex exec` via Bash, and return the report (use `schema` on the wrapper to get structured output back).
- Always label these agents with a `gpt-5.6-sol:` prefix, e.g. `{label: 'gpt-5.6-sol:review-auth'}` — the workflow UI shows the wrapper's Claude model, so the label is the only indication the real worker is gpt-5.6-sol.
- Codex runs can exceed Bash's 10-minute timeout: pass an explicit timeout, or run in the background and poll for the report file.
- Parallel gpt-5.6-sol implementation agents must use `isolation: 'worktree'` so codex edits don't collide in the shared checkout.
- Workflow token budgets only count Claude tokens; codex work is free and invisible to `budget.spent()`.

## Long-running Codex Work

gpt-5.6-sol is exceptionally capable on long-running tasks. Give it substantial, multi-step work when it is the right model for the job; do not split work up merely because it is large.

- The quality of the result depends on the prompt. Provide a detailed, self-contained brief: goal, relevant context, constraints, files or systems in scope, expected deliverables, and how to verify completion.
- State important decisions and non-negotiable requirements explicitly. Do not assume the model will infer project-specific conventions or the desired tradeoffs from a short prompt.
- For long tasks, ask it to inspect the current state first, execute the work end to end, and report the changes, verification, and any remaining risks.
- If the work can safely run in parallel, keep each task's ownership and worktree boundaries explicit so agents do not overlap.

## Transcript Performance Guardrails

- Treat transcript auto-scroll as a live-output feature, not a generic "working" feature. Buffering, reconnecting, pending approvals, and tool-only activity must not be wired as if assistant text is actively streaming.
- When wiring scroll-follow logic, count real transcript messages only. Tool/work rows must not retrigger the same "new content arrived" auto-stick path.
- Prefer the simpler fork-style transcript path for the common case. Small and medium transcripts should avoid virtualization churn unless there is a clear measured need.
- If virtualization is used, never couple `rowVirtualizer.measure()` directly to another bottom-stick or height-follow cycle. Height-follow for live output should stay one-way to avoid measure/scroll feedback loops.
- Preserve these behaviors with focused transcript tests when changing chat scrolling, timeline measurement, or sidebar-driven transcript updates.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## UI Conventions

### Human approval gate for Pencil work

- When a task involves Pencil or other design work that will inform implementation, complete and present the design work first. Do not begin or continue the corresponding code implementation until the human has explicitly reviewed the design and approved it as final.
- Iterate only in the design source while design review is pending. An initial request to build the feature, silence, or approval of an earlier concept does not count as approval of the current design.
- After explicit design approval in the current conversation, implementation may proceed from the approved design.

### Pencil-to-code component structure

Treat the active Penkra `.pen` file as the authority for the component catalog and its grouping.

- Mirror each user-visible Pencil component group directly under `apps/web/src/components/`. For example, direct reusable children of Pencil's `Left Rail` group belong directly under `apps/web/src/components/left-rail/`; do not invent an intermediate category that does not exist in Pencil.
- Mirror a Pencil component's slash-separated name as a kebab-case folder and named React component. Keep Pencil and code names recognizable in both directions.
- Keep composed feature screens separate from reusable component definitions. A screen may compose components from several groups without changing those components' ownership.
- Cross-cutting implementation primitives in `components/ui` may remain framework-oriented when they are not user-visible Pencil components. A user-visible component may be placed outside its Pencil group only when the design itself identifies it as shared across groups; document that exception beside the component.
- Before translating a component, verify its actual Pencil parent rather than inferring ownership from where an instance appears.
- When an orphaned or misplaced Pencil component is discovered, correct the Pencil hierarchy and audit the rest of the component catalog for the same inconsistency before adding more code.
- Every structural design-to-code pass must compare the direct reusable children of each Pencil component group with the corresponding code directories. Report and resolve missing, extra, orphaned, or mismatched entries instead of silently creating a new organization.

### Open/close (toggle) animations — single source

Any UI element with an open/close toggle (expand/collapse, show/hide, disclosure) MUST reuse the shared disclosure motion in `apps/web/src/lib/disclosureMotion.ts`. Never write bespoke height/opacity transitions or one-off `@keyframes` for a toggle. Vertical disclosures use native intrinsic-size interpolation (`height: 0` to `height: auto`) with the productive expansion motion token and `motion-reduce` fallback; do not reintroduce measured-height, grid-row, content-count, or cleanup-buffer heuristics.

- Shell + content (used by open/close project, sidebar sections, composer suggestions): `disclosureShellClassName(open)` on the intrinsic-height shell, `DISCLOSURE_INNER_CLASS` on the inner wrapper, `disclosureContentClassName(open)` on the content — or the ready-made `DisclosureRegion` component (`apps/web/src/components/ui/DisclosureRegion.tsx`).
- Base UI `<Collapsible>` panels: wrap with `CollapsiblePanel` (`apps/web/src/components/ui/collapsible.tsx`), which applies `DISCLOSURE_COLLAPSIBLE_PANEL_CLASS`.
- Rotating chevron affordance: `DisclosureChevron` / `disclosureChevronClassName(open)`.

Reference usage: opening/closing a project and the sidebar sections in `apps/web/src/components/Sidebar.tsx`. If you find a toggle that animates differently, migrate it to this module rather than duplicating logic.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@penkra/shared/git`) — no barrel index.

## Local Dev Instance Isolation

- `bun run dev:desktop:install-app` installs the standard Applications launchers: `Penkra Dev`, `Penkra Dev 2`, and `Penkra Dev 3`. Slot 1 deliberately keeps the established `~/Penkra_Dev` state; later slots use isolated state below `~/Penkra_Dev/.instances/<slot>`.
- Launch numbered desktop instances from Applications. They share the local account API, website, registry, renderer build, and source watchers, while keeping login/session data, Chromium profiles, Penkra databases, tabs, Threads, logs, process identity, and embedded desktop backends separate.
- The first numbered app starts the shared services. Closing one app stops only that desktop; shared services stop after the last numbered app closes.
- To install another stable slot, run `bun run dev:desktop:install-app -- <slot>`, then launch `Penkra Dev <slot>` normally from Applications. The slot is a positive integer and is derived by the same resolver; three is a provisioned default, not a maximum.
- Do not recreate numbered Apps by manually setting environment variables, copying `.app` bundles, renaming Electron, or choosing ad hoc ports/paths. Those bypass the canonical bundle IDs, URL schemes, profiles, locks, and lifecycle coordination.
- Browser-only development remains separate from numbered desktop QA. When an intentionally isolated browser server is required, use `scripts/dev-runner.ts` with an explicit home and dry-run its port selection first; never present that workflow as a Penkra Dev desktop instance.
- If the UI shows no threads, verify which numbered root and embedded backend the window owns before changing SQL. A healthy snapshot with projects/threads means the issue is client connection/hydration, not empty history.

## SQLite ownership and recovery

- Never open, query, copy, rename, replace, restore, or run a SQLite utility against a Penkra `state.sqlite` while its desktop or backend may be running. Read-only SQLite connections can still participate in WAL recovery, checkpoint, and close-time cleanup.
- Live diagnosis must use Penkra's registered Thread/diagnostic surfaces or backend APIs. The database file is not a live diagnostic API.
- Offline verification uses `penkra-database verify <absolute-database-path>`. It acquires the same lifecycle lock as the backend and refuses to run while a Penkra owner is live. Do not substitute the system `sqlite3` binary, an IDE database extension, a generic SQLite browser, or a hand-written Node/Bun script.
- Stop every Penkra process for the target numbered root before verification or recovery. Numbered Dev slots have separate databases; resolve the exact slot instead of assuming `~/Penkra_Dev`.
- Penkra database owners require SQLite 3.51.3 or newer. A runtime that cannot report or satisfy that version must fail closed before WAL mode is enabled.
- A SQLite file that passes `integrity_check` is not automatically a valid Penkra recovery. Verification must also confirm migration lineage, authoritative orchestration events, projection sequence bounds, and event JSON.
- Live or migration snapshots must use SQLite's Online Backup API or `VACUUM INTO`. Never make a raw filesystem copy of a live main database without its coordinated SQLite snapshot boundary.
- See `docs/database-reliability.md` for architecture, supported maintenance, and the destructive/concurrency QA matrix.

## Codex App Server (Important)

Penkra is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
