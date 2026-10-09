# 0.14.4 clean-core — step notes (evidence and decisions)

Companion to `TODO.md` (the approved plan). Factual record only; no planning.

## Step 1 — git

Decision (operator, 2026-10-09): **leave the 8 non-`main` branches that are checked out
outside `penkra-worktrees/`**. Those worktrees are separate environments (repo root checkout,
`penkra-host`, `Penkra_Dev` live workspaces) and may be in use; the rebuild does not need them
gone. Do not touch them.

State after step 1:

- `main` = `445bc9b8c` (tag `v0.14.3` = `origin/main`).
- `penkra-worktrees/release-0143` is on `main`.
- Cherry-picks: `561a3c356` (browser upload paths), `e8bd5dc0a` (explicit tab activation),
  `842c160b9` (reserve Production migrations 173-175), `25e51d0f2` (this plan).
- Dropped `6ed13bbc8`, `db2e633f8`, `9e2aa7753`, `5396168e1` (absent from `main`, preserved by
  tag `archive/release/0.14.3` = `5396168e1`).
- `archive/prod-complete-candidate` = `594921b8f` (WIP snapshot); its worktree removed.
- 14 `archive/*` tags; 78 branches deleted. 8 branches left checked out (decision above).

## Step 2 — inventory check vs plan 4.1

Confirmed against code (`grep -rlw` over `apps/server/src` + `packages`, excluding
`/Migrations/` and `*.test.*`). Every Production table is classified, and every classification
matches the plan **except one**:

- **Difference: `project_pull_request_pins` is listed "Kept" but has zero non-migration code
  references** — only `069_ProjectPullRequestPins.ts` and `Migrations.test.ts` mention it. There
  is no repository/reader/writer. It is currently dead data, like `git_thread_environment_operations`.
  Following the plan as written (Kept); flagging in case it should be dropped.

Notes for the step-4 drop migration:

- `provider_runtime_retention_state`, `provider_runtime_retention_turn_work`,
  `provider_runtime_retention_event_work` have zero code users in this tree (they were created by
  the candidate's migration 173, which is a reserved no-op here). They exist only on Production,
  so their drop must be `IF EXISTS`.
- Production also has view `thread_activities_read` (depends on `projection_thread_activities`,
  `operations`, `notices`) and FTS shadow tables `projection_thread_messages_search*`. The drop
  order must remove the view before its base tables, and the FTS table drops its shadow tables.

Verified counts (read-only Production, 2026-10-09): 576 `projection_threads`, 42 stuck running
unbound `projection_turns` across 24 threads (14 not deleted), 820,000 `orchestration_command_receipts`,
767,001 `orchestration_events`.
