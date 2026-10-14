// FILE: ProviderThreadSwitchCoordinator.ts
// Purpose: Copy native state and admit a turn using the canonical thread row.

import { randomUUID } from "node:crypto";
import { providerSupportsNativeTurnSteering } from "@penkra/shared/providerMetadata";
import { ModelSelection, ProviderConnectionId, ThreadId, TurnId } from "@penkra/contracts";
import { Cause, Effect, Layer, Option, PubSub, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { settleMessage } from "../../cleanCore/sendMessage.ts";
import { readSendCohort } from "../../cleanCore/sendPayload.ts";
import { ThreadLanes, ThreadLanesLive } from "../../cleanCore/ThreadLanes.ts";
import { ThreadPublisher } from "../../cleanCore/ThreadPublisher.ts";
import { ProviderNativeStateMaterializer } from "../../provider/Services/ProviderNativeStateMaterializer.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
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
  const scope = yield* Effect.scope;
  const dispatch = yield* TurnDispatch;
  const sql = yield* SqlClient.SqlClient;
  const publisher = yield* ThreadPublisher;
  const lanes = yield* ThreadLanes;
  const resolver = yield* ProviderTurnSelectionResolver;
  const provider = yield* ProviderService;
  const directory = yield* ProviderSessionDirectory;
  const materializer = yield* ProviderNativeStateMaterializer;

  const AdmissionThread = Schema.Struct({
    provider: Schema.Literals(["codex", "claudeAgent", "opencode"]),
    connectionId: Schema.NullOr(ProviderConnectionId),
    nativeStateId: Schema.NullOr(Schema.String),
    providerSessionId: Schema.NullOr(Schema.String),
    state: Schema.Literals(["idle", "running", "error"]),
    activeTurnId: Schema.NullOr(TurnId),
    model: Schema.String,
    modelOptions: Schema.NullOr(Schema.String),
  });
  const readThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* sql`SELECT provider, connection_id AS "connectionId",
        native_state_id AS "nativeStateId", provider_session_id AS "providerSessionId",
        state, active_turn_id AS "activeTurnId", model, model_options AS "modelOptions"
        FROM threads WHERE id=${threadId} AND deleted_at IS NULL`;
      if (rows[0] === undefined) return yield* Effect.fail(failure("The thread does not exist."));
      const thread = yield* Schema.decodeUnknownEffect(AdmissionThread)(rows[0]);
      // Native acceptance can precede the canonical turn.started write. Use the
      // exact accepted turn in that phase, not merely the process's running status.
      const binding = yield* directory.getBinding(threadId);
      const payload = Option.isSome(binding) ? binding.value.runtimePayload : null;
      if (
        thread.state !== "running" &&
        Option.isSome(binding) &&
        binding.value.status === "running" &&
        typeof payload === "object" &&
        payload !== null &&
        "activeTurnId" in payload &&
        typeof payload.activeTurnId === "string"
      )
        return {
          ...thread,
          state: "running" as const,
          activeTurnId: TurnId.makeUnsafe(payload.activeTurnId),
        };
      return thread;
    }).pipe(
      Effect.mapError((cause) => failure("Could not read the thread before admission.", cause)),
    );

  type AdmissionInput = Parameters<ProviderThreadSwitchCoordinatorShape["dispatchTurnStart"]>[0];
  const pending = new Map<ThreadId, Array<{ turnId: TurnId; input: AdmissionInput }>>();
  const dispatchTurnAdmission = Effect.fnUntraced(function* (input: {
    readonly command: TurnAdmissionCommand;
    readonly attachmentPrincipal: Parameters<
      ProviderThreadSwitchCoordinatorShape["dispatchTurnStart"]
    >[0]["attachmentPrincipal"];
    readonly cwd?: string;
  }) {
    const thread = yield* readThread(input.command.threadId);
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

      const turnId = thread.activeTurnId;
      if (turnId === null)
        return yield* Effect.fail(failure("The running thread has no active turn."));
      const entry = { turnId, input };
      const entries = pending.get(input.command.threadId) ?? [];
      entries.push(entry);
      pending.set(input.command.threadId, entries);
      // Record before interrupting: turn.ended may arrive during the provider call.
      yield* provider.interruptTurn({ threadId: input.command.threadId, turnId }).pipe(
        Effect.mapError((cause) =>
          failure("Could not interrupt the running turn before switching.", cause),
        ),
        Effect.onError(() =>
          Effect.sync(() => {
            const remaining = (pending.get(input.command.threadId) ?? []).filter(
              (item) => item !== entry,
            );
            if (remaining.length) pending.set(input.command.threadId, remaining);
            else pending.delete(input.command.threadId);
          }),
        ),
      );
      return { turnId: null };
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

  const events = yield* PubSub.subscribe(publisher.providerEvents);
  const deliverPending = (threadId: ThreadId, turnId: string) =>
    lanes
      .run(
        threadId,
        Effect.gen(function* () {
          const entries = pending.get(threadId) ?? [];
          const ready = entries.filter((entry) => entry.turnId === turnId);
          const remaining = entries.filter((entry) => entry.turnId !== turnId);
          if (remaining.length) pending.set(threadId, remaining);
          else pending.delete(threadId);
          for (const entry of ready) {
            if ((yield* readSendCohort(threadId, entry.input.command.message.messageId)) === null)
              continue;
            yield* dispatchTurnAdmission(entry.input).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause))
                  return Effect.failCause(cause).pipe(Effect.orDie);
                const failure = Cause.squash(cause);
                const error = failure instanceof Error ? failure.message : String(failure);
                return settleMessage(
                  publisher,
                  {
                    type: "failed",
                    threadId,
                    messageId: entry.input.command.message.messageId,
                    error,
                  },
                  new Date().toISOString(),
                ).pipe(
                  Effect.andThen(
                    Effect.logError("pending provider delivery failed", {
                      threadId,
                      messageId: entry.input.command.message.messageId,
                      error,
                    }),
                  ),
                );
              }),
            );
          }
        }),
        "delivery",
      )
      .pipe(Effect.provideService(SqlClient.SqlClient, sql));
  yield* Stream.fromEffectRepeat(PubSub.take(events)).pipe(
    Stream.runForEach((event) => {
      if (event.type === "turn.ended")
        return Effect.forkIn(
          deliverPending(ThreadId.makeUnsafe(event.threadId), event.turnId),
          scope,
        );
      if (event.type === "provider.exited" || event.type === "provider.failed")
        return Effect.sync(() => {
          for (const id of event.threadIds) pending.delete(ThreadId.makeUnsafe(id));
        });
      return Effect.void;
    }),
    Effect.forkIn(scope),
  );
  return {
    dispatchTurnStart: (input) =>
      dispatchTurnAdmission(input).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  } satisfies ProviderThreadSwitchCoordinatorShape;
});

export const ProviderThreadSwitchCoordinatorLive = Layer.effect(
  ProviderThreadSwitchCoordinator,
  makeProviderThreadSwitchCoordinator,
).pipe(Layer.provideMerge(ThreadLanesLive));
