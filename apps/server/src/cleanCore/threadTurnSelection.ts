import type {
  ModelSelection,
  ProviderConnectionId,
  ThreadId,
  RuntimeMode,
} from "@penkra/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Called inside turn admission's transaction, after copying any native state. */
export const commitThreadTurnSelection = (input: {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection | undefined;
  readonly connectionId: ProviderConnectionId | null | undefined;
  readonly nativeState:
    | { readonly id: string; readonly providerSessionId: string | null }
    | undefined;
  readonly runtimeMode?: RuntimeMode;
  readonly updatedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE threads SET
    runtime_mode = CASE WHEN ${Number(input.runtimeMode !== undefined)} THEN ${input.runtimeMode ?? null} ELSE runtime_mode END,
    connection_id = CASE WHEN ${Number(input.connectionId !== undefined)} THEN ${input.connectionId ?? null} ELSE connection_id END,
    model = CASE WHEN ${Number(input.modelSelection !== undefined)} THEN ${input.modelSelection?.model ?? null} ELSE model END,
    model_options = CASE WHEN ${Number(input.modelSelection !== undefined)} THEN ${input.modelSelection?.options === undefined ? null : JSON.stringify(input.modelSelection.options)} ELSE model_options END,
    native_state_id = CASE WHEN ${Number(input.nativeState !== undefined)} THEN ${input.nativeState?.id ?? null} ELSE native_state_id END,
    provider_session_id = CASE WHEN ${Number(input.nativeState !== undefined)} THEN ${input.nativeState?.providerSessionId ?? null} ELSE provider_session_id END,
    updated_at = ${input.updatedAt}
    WHERE id = ${input.threadId}`;
  });
