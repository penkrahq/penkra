import { ProviderConnectionId, ProviderKind, RuntimeMode, ThreadId } from "@penkra/contracts";
import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

const ThreadNativeState = Schema.Struct({
  threadId: ThreadId,
  provider: ProviderKind,
  connectionId: Schema.NullOr(ProviderConnectionId),
  nativeStateId: Schema.NullOr(Schema.String),
  providerSessionId: Schema.NullOr(Schema.String),
  model: Schema.String,
  modelOptions: Schema.NullOr(Schema.String),
  runtimeMode: RuntimeMode,
});
export type ThreadNativeState = typeof ThreadNativeState.Type;

/** One canonical row; no persisted binding, locator or revision. */
export const readThreadNativeState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<ThreadNativeState>`SELECT id AS "threadId", provider,
    connection_id AS "connectionId", native_state_id AS "nativeStateId",
    provider_session_id AS "providerSessionId", model, model_options AS "modelOptions",
    runtime_mode AS "runtimeMode" FROM threads WHERE id=${threadId} AND deleted_at IS NULL`;
    return rows[0] === undefined
      ? Option.none<ThreadNativeState>()
      : Option.some(yield* Schema.decodeUnknownEffect(ThreadNativeState)(rows[0]));
  });
