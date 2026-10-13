// FILE: ProviderThreadSwitchCoordinator.ts
// Purpose: Copy native state and admit a turn using the canonical thread row.

import { randomUUID } from "node:crypto";
import { providerSupportsNativeTurnSteering } from "@penkra/shared/providerMetadata";
import { ModelSelection, ProviderConnectionId, ThreadId } from "@penkra/contracts";
import { Deferred, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadPublisher } from "../../cleanCore/ThreadPublisher.ts";
import { ProviderNativeStateMaterializer } from "../../provider/Services/ProviderNativeStateMaterializer.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderTurnSelectionResolver } from "../../provider/Services/ProviderTurnSelectionResolver.ts";
import { TurnDispatch } from "../../cleanCore/turnDispatch.ts";
import { commitThreadTurnSelection } from "../../cleanCore/threadTurnSelection.ts";
import {
  ProviderThreadSwitchCoordinator,
  ProviderThreadSwitchCoordinatorError,
  type ProviderThreadSwitchCoordinatorShape,
  type TurnAdmissionCommand,
} from "../Services/ProviderThreadSwitchCoordinator.ts";

const failure = (detail: string, cause?: unknown) =>
  new ProviderThreadSwitchCoordinatorError({ detail, ...(cause === undefined ? {} : { cause }) });

export const makeProviderThreadSwitchCoordinator = Effect.gen(function* () {
  const dispatch = yield* TurnDispatch;
  const sql = yield* SqlClient.SqlClient;
  const publisher = yield* ThreadPublisher;
  const resolver = yield* ProviderTurnSelectionResolver;
  const provider = yield* ProviderService;
  const materializer = yield* ProviderNativeStateMaterializer;

  const AdmissionThread = Schema.Struct({
    provider: Schema.Literals(["codex", "claudeAgent", "opencode"]),
    connectionId: Schema.NullOr(ProviderConnectionId),
    nativeStateId: Schema.NullOr(Schema.String),
    providerSessionId: Schema.NullOr(Schema.String),
    state: Schema.Literals(["idle", "running", "error"]),
    model: Schema.String,
    modelOptions: Schema.NullOr(Schema.String),
  });
  const readThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT provider, connection_id AS "connectionId",
        native_state_id AS "nativeStateId", provider_session_id AS "providerSessionId",
        state, model, model_options AS "modelOptions"
        FROM threads WHERE id=${threadId} AND deleted_at IS NULL`;
      if (rows[0] === undefined) return yield* Effect.fail(failure("The thread does not exist."));
      return yield* Schema.decodeUnknownEffect(AdmissionThread)(rows[0]);
    }).pipe(
      Effect.mapError((cause) => failure("Could not read the thread before admission.", cause)),
    );

  // Subscribe before reading so a turn end between the read and await cannot be lost.
  const waitForIdle = (
    threadId: ThreadId,
  ): Effect.Effect<void, ProviderThreadSwitchCoordinatorError> =>
    Effect.gen(function* () {
      let running: boolean;
      do {
        running = yield* Effect.scoped(
          Effect.gen(function* () {
            const changed = yield* Deferred.make<void>();
            const unsubscribe = publisher.subscribe(threadId, () =>
              Effect.runSync(Deferred.succeed(changed, undefined)),
            );
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
            const thread = yield* readThread(threadId);
            if (thread.state !== "running") return false;
            yield* Deferred.await(changed);
            return true;
          }),
        );
      } while (running);
    });

  const dispatchTurnAdmission = Effect.fnUntraced(function* (input: {
    readonly command: TurnAdmissionCommand;
    readonly attachmentPrincipal: Parameters<
      ProviderThreadSwitchCoordinatorShape["dispatchTurnStart"]
    >[0]["attachmentPrincipal"];
    readonly cwd?: string;
  }) {
    let thread = yield* readThread(input.command.threadId);
    const nativeSteer =
      input.command.dispatchMode === "steer" &&
      providerSupportsNativeTurnSteering(thread.provider) &&
      thread.state === "running" &&
      (input.command.connectionId === undefined ||
        input.command.connectionId === thread.connectionId);
    // A steer remains on the running turn's account and model. The draft still
    // carries the next-turn selection, which queue delivery reads when it starts.
    const modelSelection = nativeSteer
      ? Schema.decodeUnknownSync(ModelSelection)({
          provider: thread.provider,
          model: thread.model,
          ...(thread.modelOptions === null ? {} : { options: JSON.parse(thread.modelOptions) }),
        })
      : input.command.modelSelection;

    if (!nativeSteer && thread.state === "running") {
      yield* resolver
        .authorizeConnection({
          harness: thread.provider,
          modelSelection: modelSelection ?? { provider: thread.provider, model: thread.model },
          connectionId:
            input.command.connectionId === undefined
              ? thread.connectionId
              : input.command.connectionId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderThreadSwitchCoordinatorError({
                code: cause.code,
                detail: cause.message,
                cause,
              }),
          ),
        );

      if (input.command.dispatchMode === "steer") {
        yield* provider
          .interruptTurn({ threadId: input.command.threadId })
          .pipe(
            Effect.mapError((cause) =>
              failure("Could not interrupt the running turn before switching.", cause),
            ),
          );
      }
      yield* waitForIdle(input.command.threadId);
      thread = yield* readThread(input.command.threadId);
    }

    const selection = yield* resolver
      .resolveExisting({
        threadId: input.command.threadId,
        ...(modelSelection === undefined ? {} : { modelSelection }),
        ...(nativeSteer
          ? { connectionId: thread.connectionId }
          : input.command.connectionId === undefined
            ? {}
            : { connectionId: input.command.connectionId }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderThreadSwitchCoordinatorError({
              code: cause.code,
              detail: cause.message,
              cause,
            }),
        ),
      );

    let nativeState: { id: string; providerSessionId: string | null } | undefined;
    if (
      !nativeSteer &&
      (selection.connectionId !== thread.connectionId || thread.nativeStateId === null)
    ) {
      // Release the old process before copying its files. Nothing is written to
      // the row until admission commits the selection and folder together.
      yield* provider
        .stopSession({ threadId: input.command.threadId })
        .pipe(
          Effect.mapError((cause) =>
            failure("Could not stop the source provider session before switching.", cause),
          ),
        );
      const id = randomUUID();
      if (thread.nativeStateId === null || thread.providerSessionId === null) {
        nativeState = { id, providerSessionId: null };
      } else {
        const copied = yield* materializer
          .clone({
            harness: selection.harness,
            providerSessionId: thread.providerSessionId,
            sourceNativeStateId: thread.nativeStateId,
            targetNativeStateId: id,
          })
          .pipe(
            Effect.mapError((cause) =>
              failure("Could not copy the thread's native conversation.", cause),
            ),
          );
        nativeState = { id, providerSessionId: copied.providerSessionId };
      }
    } else if (!nativeSteer && selection.changed) {
      yield* provider
        .stopSession({ threadId: input.command.threadId })
        .pipe(
          Effect.mapError((cause) =>
            failure("Could not restart the provider for the selected model.", cause),
          ),
        );
    }
    const selectedModel =
      modelSelection ??
      Schema.decodeUnknownSync(ModelSelection)({
        provider: selection.harness,
        model: selection.modelId,
        ...(thread.modelOptions === null ? {} : { options: JSON.parse(thread.modelOptions) }),
      });
    const discardUncommitted = Effect.gen(function* () {
      if (nativeState === undefined) return;
      const rows = yield* sql<{
        nativeStateId: string | null;
      }>`SELECT native_state_id AS "nativeStateId" FROM threads WHERE id=${input.command.threadId}`;
      if (rows[0]?.nativeStateId !== nativeState.id) yield* materializer.discard(nativeState.id);
    });
    if (!nativeSteer)
      yield* sql
        .withTransaction(
          commitThreadTurnSelection({
            threadId: input.command.threadId,
            modelSelection: selectedModel,
            connectionId: selection.connectionId,
            nativeState,
            runtimeMode: input.command.runtimeMode,
            updatedAt: input.command.createdAt,
          }),
        )
        .pipe(
          Effect.mapError((cause) => failure("Could not commit the turn selection.", cause)),
          Effect.onError(() => discardUncommitted.pipe(Effect.orDie)),
        );
    const committed = {
      ...selection,
      nativeStateId: nativeState?.id ?? thread.nativeStateId,
      providerSessionId:
        nativeState === undefined ? thread.providerSessionId : nativeState.providerSessionId,
      changed: false,
    };
    const result = yield* dispatch
      .dispatch({
        command: {
          ...input.command,
          modelSelection: selectedModel,
          connectionId: selection.connectionId,
        },
        selection: committed,
        modelSelection: selectedModel,
        nativeSteer,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      })
      .pipe(
        Effect.mapError((cause) =>
          failure(cause instanceof Error ? cause.message : String(cause), cause),
        ),
      );
    yield* discardUncommitted.pipe(
      Effect.mapError((cause) => failure("Could not discard uncommitted native state.", cause)),
    );
    return { turnId: result.turnId };
  });

  return {
    dispatchTurnStart: (input) =>
      dispatchTurnAdmission(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  } satisfies ProviderThreadSwitchCoordinatorShape;
});

export const ProviderThreadSwitchCoordinatorLive = Layer.effect(
  ProviderThreadSwitchCoordinator,
  makeProviderThreadSwitchCoordinator,
);
