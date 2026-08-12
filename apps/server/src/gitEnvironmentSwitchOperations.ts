import {
  GitSwitchThreadEnvironmentInput,
  GitSwitchThreadEnvironmentResult,
  type OrchestrationCommand,
} from "@penkra/contracts";
import { Data, Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type EnvironmentSwitchPhase = "pending" | "git_applied" | "completed" | "uncertain";

interface EnvironmentSwitchRow {
  readonly commandId: string;
  readonly threadId: string;
  readonly inputJson: string;
  readonly phase: EnvironmentSwitchPhase;
  readonly resultJson: string | null;
}

export type GitEnvironmentSwitchOperation =
  | { readonly phase: "new" }
  | { readonly phase: "pending" | "uncertain" }
  | {
      readonly phase: "git_applied" | "completed";
      readonly result: GitSwitchThreadEnvironmentResult;
    };

export class GitEnvironmentSwitchOperationError extends Data.TaggedError(
  "GitEnvironmentSwitchOperationError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const operationError = (message: string) => (cause: unknown) =>
  new GitEnvironmentSwitchOperationError({ message, cause });

const parseResult = (row: EnvironmentSwitchRow) =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(GitSwitchThreadEnvironmentResult)(JSON.parse(row.resultJson ?? "")),
    catch: operationError(`Invalid persisted Git environment switch result for ${row.commandId}.`),
  });

const readOperation = (commandId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<EnvironmentSwitchRow>`
      SELECT
        command_id AS "commandId",
        thread_id AS "threadId",
        input_json AS "inputJson",
        phase,
        result_json AS "resultJson"
      FROM git_thread_environment_operations
      WHERE command_id = ${commandId}
    `.pipe(Effect.mapError(operationError("Failed to read Git environment switch operation.")));
    return rows[0] ?? null;
  });

const decodeOperation = (
  row: EnvironmentSwitchRow,
): Effect.Effect<GitEnvironmentSwitchOperation, GitEnvironmentSwitchOperationError> =>
  row.phase === "git_applied" || row.phase === "completed"
    ? parseResult(row).pipe(Effect.map((result) => ({ phase: row.phase, result })))
    : Effect.succeed({ phase: row.phase });

export const beginGitEnvironmentSwitch = (input: GitSwitchThreadEnvironmentInput) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const inputJson = JSON.stringify(input);
    const now = new Date().toISOString();
    const inserted = yield* sql<{ readonly commandId: string }>`
      INSERT INTO git_thread_environment_operations (
        command_id, thread_id, input_json, phase, result_json, created_at, updated_at
      ) VALUES (
        ${input.commandId}, ${input.threadId}, ${inputJson}, 'pending', NULL, ${now}, ${now}
      )
      ON CONFLICT (command_id) DO NOTHING
      RETURNING command_id AS "commandId"
    `.pipe(Effect.mapError(operationError("Failed to begin Git environment switch operation.")));
    if (inserted.length > 0) return { phase: "new" } as const;

    const existing = yield* readOperation(input.commandId);
    if (!existing || existing.threadId !== input.threadId || existing.inputJson !== inputJson) {
      return yield* new GitEnvironmentSwitchOperationError({
        message: `Git environment switch command identity ${input.commandId} was reused with different input.`,
      });
    }
    return yield* decodeOperation(existing);
  });

export const recordGitEnvironmentSwitchResult = (
  commandId: string,
  result: GitSwitchThreadEnvironmentResult,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const resultJson = JSON.stringify(result);
    const now = new Date().toISOString();
    yield* sql`
      UPDATE git_thread_environment_operations
      SET phase = 'git_applied', result_json = ${resultJson}, updated_at = ${now}
      WHERE command_id = ${commandId} AND phase = 'pending'
    `.pipe(
      Effect.mapError(operationError("Failed to persist applied Git environment switch result.")),
    );
  });

export const completeGitEnvironmentSwitch = (commandId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE git_thread_environment_operations
      SET phase = 'completed', updated_at = ${new Date().toISOString()}
      WHERE command_id = ${commandId} AND phase = 'git_applied'
    `.pipe(Effect.mapError(operationError("Failed to complete Git environment switch operation.")));
  });

export const discardPendingGitEnvironmentSwitch = (commandId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      DELETE FROM git_thread_environment_operations
      WHERE command_id = ${commandId} AND phase = 'pending'
    `.pipe(
      Effect.mapError(operationError("Failed to discard failed Git environment switch operation.")),
    );
  });

export const gitEnvironmentSwitchMetadataCommand = (
  input: Pick<GitSwitchThreadEnvironmentInput, "commandId" | "threadId">,
  result: GitSwitchThreadEnvironmentResult,
): OrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: input.commandId,
  threadId: input.threadId,
  envMode: result.targetMode,
  branch: result.branch,
  worktreePath: result.worktreePath,
  associatedWorktreePath: result.associatedWorktreePath,
  associatedWorktreeBranch: result.associatedWorktreeBranch,
  associatedWorktreeRef: result.associatedWorktreeRef,
  ...(result.targetMode === "worktree" ? { createBranchFlowCompleted: false } : {}),
});

export const recoverGitEnvironmentSwitchOperations = (
  dispatch: (command: OrchestrationCommand) => Effect.Effect<unknown, unknown>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const interrupted = yield* sql<{ readonly commandId: string }>`
      UPDATE git_thread_environment_operations
      SET phase = 'uncertain', updated_at = ${new Date().toISOString()}
      WHERE phase = 'pending'
      RETURNING command_id AS "commandId"
    `.pipe(Effect.mapError(operationError("Failed to fence interrupted Git environment switchs.")));
    if (interrupted.length > 0) {
      yield* Effect.logWarning(
        "Git environment switchs were interrupted before their result was durable",
        {
          commandIds: interrupted.map(({ commandId }) => commandId),
        },
      );
    }

    const rows = yield* sql<EnvironmentSwitchRow>`
      SELECT
        command_id AS "commandId",
        thread_id AS "threadId",
        input_json AS "inputJson",
        phase,
        result_json AS "resultJson"
      FROM git_thread_environment_operations
      WHERE phase = 'git_applied'
      ORDER BY updated_at ASC, command_id ASC
    `.pipe(Effect.mapError(operationError("Failed to list recoverable Git environment switchs.")));

    for (const row of rows) {
      const input = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(GitSwitchThreadEnvironmentInput)(JSON.parse(row.inputJson)),
        catch: operationError(
          `Invalid persisted Git environment switch input for ${row.commandId}.`,
        ),
      });
      const result = yield* parseResult(row);
      yield* dispatch(gitEnvironmentSwitchMetadataCommand(input, result)).pipe(
        Effect.mapError(
          operationError(`Failed to recover Git environment switch ${row.commandId}.`),
        ),
      );
      yield* completeGitEnvironmentSwitch(row.commandId);
    }
  });
