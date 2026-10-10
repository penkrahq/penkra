import { randomUUID } from "node:crypto";
import {
  CommandId,
  MessageId,
  ModelSelection,
  RuntimeMode,
  ThreadId,
  type CleanCoreSendResult,
  type ProviderConnectionId,
} from "@penkra/contracts";
import { Deferred, Effect, Layer, Option, Schema, Semaphore, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderThreadSwitchCoordinator } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ThreadProviderBindingRepository } from "../persistence/Services/ThreadProviderBindings.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "../managedAttachmentPrincipal.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { sendMessage, type SendDriver } from "./sendMessage.ts";
import { readThreadQueue, QueuedMessage } from "./threadQueue.ts";
import { providerSupportsNativeTurnSteering } from "@penkra/shared/providerMetadata";

export interface ThreadSendInput {
  readonly threadId: ThreadId;
  readonly message: QueuedMessage;
  readonly dispatchMode: "queue" | "steer";
  readonly modelSelection?: ModelSelection;
  readonly connectionId?: ProviderConnectionId | null;
}
export class ThreadSender extends ServiceMap.Service<
  ThreadSender,
  {
    readonly send: (input: ThreadSendInput) => Effect.Effect<CleanCoreSendResult, Error>;
    readonly queuedThread: (messageId: string) => Effect.Effect<ThreadId | null>;
    readonly cancelQueued: (input: {
      threadId: ThreadId;
      messageId: string;
    }) => Effect.Effect<{ threadId: ThreadId; messageId: string; removed: boolean }, Error>;
    readonly interrupt: (
      threadId: ThreadId,
    ) => Effect.Effect<{ threadId: ThreadId; interruptRequested: boolean }, Error>;
  }
>()("penkra/cleanCore/ThreadSender") {}

export const makeThreadSender = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const publisher = yield* ThreadPublisher;
  const coordinator = yield* ProviderThreadSwitchCoordinator;
  const bindings = yield* ThreadProviderBindingRepository;
  const provider = yield* ProviderService;
  const queues = new Map<string, readonly QueuedMessage[]>();
  let after: string | null = null;
  const decodeQueue = Schema.decodeUnknownSync(Schema.Array(QueuedMessage));
  while (true) {
    const page: readonly { id: string; queue: string }[] =
      after === null
        ? yield* sql<{
            id: string;
            queue: string;
          }>`SELECT id, queue FROM threads ORDER BY id LIMIT 50`
        : yield* sql<{
            id: string;
            queue: string;
          }>`SELECT id, queue FROM threads WHERE id > ${after} ORDER BY id LIMIT 50`;
    for (const row of page) queues.set(row.id, decodeQueue(JSON.parse(row.queue)));
    if (page.length < 50) break;
    after = page[page.length - 1]!.id;
  }
  const driver: SendDriver = {
    interrupt: (threadId) =>
      provider.interruptTurn({ threadId: ThreadId.makeUnsafe(threadId) }).pipe(Effect.asVoid),
    dispatch: (input, mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const threadId = ThreadId.makeUnsafe(input.threadId);
          const rows = yield* sql<{
            provider: string;
            model: string;
            modelOptions: string | null;
            runtimeMode: string;
            connectionId: ProviderConnectionId | null;
            workingDirectory: string | null;
          }>`SELECT provider, model, model_options AS "modelOptions", runtime_mode AS "runtimeMode", connection_id AS "connectionId", working_directory AS "workingDirectory" FROM threads WHERE id = ${threadId}`;
          const row = rows[0];
          if (row === undefined) return yield* Effect.fail(new Error("The thread does not exist."));
          const modelSelection = Schema.decodeUnknownSync(ModelSelection)({
            provider: row.provider,
            model: row.model,
            ...(row.modelOptions === null ? {} : { options: JSON.parse(row.modelOptions) }),
          });
          const runtimeMode = Schema.decodeUnknownSync(RuntimeMode)(row.runtimeMode);
          const binding = yield* bindings.getRuntimeBinding(threadId);
          const reply = yield* Deferred.make<string, Error>();
          const unsubscribe = publisher.subscribeDispatch(
            threadId,
            input.message.messageId,
            (outcome) => {
              Effect.runSync(
                outcome.type === "failed"
                  ? Deferred.fail(reply, new Error(outcome.error))
                  : Deferred.succeed(reply, outcome.turnId),
              );
            },
          );
          yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
          yield* coordinator.dispatchTurnStart({
            command: {
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(randomUUID()),
              threadId,
              message: {
                messageId: MessageId.makeUnsafe(input.message.messageId),
                role: "user",
                text: input.message.text,
                attachments: input.message.attachments,
              },
              dispatchMode: mode === "steer" ? "steer" : "queue",
              dispatchOrigin: input.message.dispatchOrigin,
              ...(input.message.senderThreadId === null
                ? {}
                : { senderThreadId: input.message.senderThreadId }),
              modelSelection,
              connectionId: row.connectionId,
              runtimeMode,
              bindingRevision: Option.isSome(binding) ? binding.value.revision : 0,
              createdAt: new Date().toISOString(),
            },
            attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
            ...(row.workingDirectory === null ? {} : { cwd: row.workingDirectory }),
          });
          return yield* Deferred.await(reply);
        }),
      ),
  };
  const lanes = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();
  const withLane = <A, E, R>(threadId: string, action: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      let lane = lanes.get(threadId);
      if (lane === undefined) {
        lane = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        lanes.set(threadId, lane);
      }
      lane.users += 1;
      const acquired = lane;
      return acquired.semaphore
        .withPermits(1)(action)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              acquired.users -= 1;
              if (acquired.users === 0) lanes.delete(threadId);
            }),
          ),
        );
    });
  return {
    queuedThread: (messageId: string) =>
      Effect.sync(() => {
        for (const [threadId, queue] of queues) {
          if (queue.some((message) => message.messageId === messageId))
            return ThreadId.makeUnsafe(threadId);
        }
        return null;
      }),
    cancelQueued: (input: { threadId: ThreadId; messageId: string }) =>
      withLane(
        input.threadId,
        Effect.gen(function* () {
          const changed = yield* sql.withTransaction(
            Effect.gen(function* () {
              const queue = yield* readThreadQueue(input.threadId);
              const remaining = queue.filter((message) => message.messageId !== input.messageId);
              if (remaining.length === queue.length) return null;
              yield* sql`UPDATE threads SET queue = ${JSON.stringify(remaining)} WHERE id = ${input.threadId}`;
              return remaining;
            }),
          );
          if (changed !== null) {
            queues.set(input.threadId, changed);
            publisher.publish({ threadId: input.threadId });
          }
          return { ...input, removed: changed !== null };
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
    interrupt: (threadId: ThreadId) =>
      withLane(
        threadId,
        Effect.gen(function* () {
          const rows = yield* sql<{
            state: string;
          }>`SELECT state FROM threads WHERE id = ${threadId}`;
          if (rows[0] === undefined)
            return yield* Effect.fail(new Error("The thread does not exist."));
          if (rows[0].state !== "running") return { threadId, interruptRequested: false };
          yield* provider.interruptTurn({ threadId });
          return { threadId, interruptRequested: true };
        }),
      ),
    send: (input: ThreadSendInput) =>
      Effect.suspend(() => {
        let lane = lanes.get(input.threadId);
        if (lane === undefined) {
          lane = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          lanes.set(input.threadId, lane);
        }
        lane.users += 1;
        const acquired = lane;
        return acquired.semaphore
          .withPermits(1)(
            Effect.gen(function* () {
              const currentRows = yield* sql<{
                provider: string;
                archivedAt: string | null;
                deletedAt: string | null;
              }>`SELECT provider, archived_at AS "archivedAt", deleted_at AS "deletedAt" FROM threads WHERE id = ${input.threadId}`;
              const current = currentRows[0];
              const failed = (error: string) => ({
                threadId: input.threadId,
                messageId: input.message.messageId,
                delivery: "failed" as const,
                error,
              });
              if (current === undefined || current.deletedAt !== null)
                return failed("The thread does not exist.");
              if (current.archivedAt !== null)
                return failed("This thread is archived. Unarchive it to send messages.");
              if (
                input.modelSelection !== undefined &&
                input.modelSelection.provider !== current.provider
              )
                return failed(
                  "This thread uses a different provider. To use another provider, start a new thread.",
                );
              if (input.modelSelection !== undefined) {
                yield* sql`UPDATE threads SET model = ${input.modelSelection.model}, model_options = ${input.modelSelection.options === undefined ? null : JSON.stringify(input.modelSelection.options)} WHERE id = ${input.threadId}`;
              }
              if (input.connectionId !== undefined)
                yield* sql`UPDATE threads SET connection_id = ${input.connectionId} WHERE id = ${input.threadId}`;
              const rows = yield* sql<{
                provider: string;
              }>`SELECT provider FROM threads WHERE id = ${input.threadId}`;
              const row = rows[0];
              if (row === undefined)
                return {
                  threadId: input.threadId,
                  messageId: input.message.messageId,
                  delivery: "failed" as const,
                  error: "The thread does not exist.",
                };
              const result = yield* sendMessage(publisher, driver, {
                ...input,
                supportsSteer: providerSupportsNativeTurnSteering(row.provider),
              });
              if (result.delivery === "queued")
                queues.set(input.threadId, yield* readThreadQueue(input.threadId));
              return result;
            }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          )
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                acquired.users -= 1;
                if (acquired.users === 0) lanes.delete(input.threadId);
              }),
            ),
          );
      }),
  };
});
export const ThreadSenderLive = Layer.effect(ThreadSender, makeThreadSender);
