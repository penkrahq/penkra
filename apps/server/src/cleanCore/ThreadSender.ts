import { ProviderAuthCircuits } from "../provider/providerAuthCircuit.ts";
import { ServerConfig } from "../config.ts";
import { ensureDurableThreadWorkspace } from "../scratchWorkspaces.ts";
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments.ts";
import {} from "node:crypto";
import {
  MessageId,
  ThreadId,
  CleanCoreThreadRuntime,
  type CleanCoreSavePromptInput,
  type CleanCoreInterruptResult,
  type CleanCoreSendAdmission,
  ProviderConnectionId,
  type CleanCoreSendMessageInput,
  type CleanCoreQueuedMessageInput,
} from "@penkra/contracts";
import { Effect, Layer, Option, PubSub, Schema, ServiceMap, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderThreadSwitchCoordinator } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import {
  CurrentManagedAttachmentPrincipal,
  type ManagedAttachmentPrincipal,
} from "../managedAttachmentPrincipal.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { ThreadLanes } from "./ThreadLanes.ts";
import { savePrompt, moveIntoDraft, deleteSavedPrompt } from "./savedPrompts.ts";
import { resolveDraftSendSelection } from "./threadDraft.ts";
import {
  deliverMessage,
  sendMessage,
  writeSendingMessage,
  type SendDriver,
} from "./sendMessage.ts";
import { readThreadQueue, QueuedMessage } from "./threadQueue.ts";
import { providerSupportsNativeTurnSteering } from "@penkra/shared/providerMetadata";

export type ThreadSendInput = CleanCoreSendMessageInput;
export class ThreadSender extends ServiceMap.Service<
  ThreadSender,
  {
    readonly resumeQueuedForConnection: (
      connectionId: ProviderConnectionId,
    ) => Effect.Effect<void, Error>;
    readonly runExclusive: <A, E, R>(
      threadId: ThreadId,
      action: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly send: (input: ThreadSendInput) => Effect.Effect<CleanCoreSendAdmission, Error>;
    readonly steerQueued: (
      input: CleanCoreQueuedMessageInput,
      callerThreadId?: ThreadId,
    ) => Effect.Effect<CleanCoreSendAdmission, Error>;
    readonly editQueued: (input: {
      threadId: ThreadId;
      messageId: string;
      updatedAt: string;
    }) => Effect.Effect<{ threadId: ThreadId; messageId: string; removed: boolean }, Error>;
    readonly queuedThread: (messageId: string) => Effect.Effect<ThreadId | null, Error>;
    readonly cancelQueued: (input: {
      threadId: ThreadId;
      messageId: string;
    }) => Effect.Effect<{ threadId: ThreadId; messageId: string; removed: boolean }, Error>;
    readonly getRuntime: (threadId: ThreadId) => Effect.Effect<CleanCoreThreadRuntime, Error>;
    readonly savePrompt: (
      input: CleanCoreSavePromptInput,
    ) => Effect.Effect<{ threadId: ThreadId; messageId: string; removed: boolean }, Error>;
    readonly restoreSavedPrompt: (input: {
      threadId: ThreadId;
      messageId: string;
      updatedAt: string;
    }) => Effect.Effect<{ threadId: ThreadId; messageId: string; removed: boolean }, Error>;
    readonly deleteSavedPrompt: (input: {
      threadId: ThreadId;
      messageId: string;
    }) => Effect.Effect<{ threadId: ThreadId; messageId: string; removed: boolean }, Error>;
    readonly interrupt: (threadId: ThreadId) => Effect.Effect<CleanCoreInterruptResult, Error>;
  }
>()("penkra/cleanCore/ThreadSender") {}

export const makeThreadSender = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const serverConfig = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const publisher = yield* ThreadPublisher;
  const withLane = (yield* ThreadLanes).run;
  const coordinator = yield* ProviderThreadSwitchCoordinator;
  const provider = yield* ProviderService;
  const directory = yield* ProviderSessionDirectory;
  const managedAttachments = yield* ManagedAttachmentRepository;
  const decodeQueue = Schema.decodeUnknownSync(Schema.Array(QueuedMessage));
  const attachmentPrincipal = (input: Parameters<SendDriver["dispatch"]>[0]) =>
    Effect.gen(function* () {
      const attachment = input.message.attachments.find(
        (attachment) => attachment.type !== "assistant-selection",
      );
      if (attachment === undefined) return yield* CurrentManagedAttachmentPrincipal;
      const claimed = yield* managedAttachments.findClaimedById({ attachmentId: attachment.id });
      if (
        Option.isNone(claimed) ||
        claimed.value.ownerThreadId !== input.threadId ||
        claimed.value.claimMessageId !== input.message.messageId
      )
        return yield* Effect.fail(
          new Error("The queued attachment is not claimed by this message."),
        );
      const row = claimed.value;
      if (row.ownerKind === "session" || row.ownerKind === "presented-media")
        return {
          ownerKind: row.ownerKind,
          ownerId: row.ownerId,
        } satisfies ManagedAttachmentPrincipal;
      if (row.ownerKind === "local-loopback" && row.ownerId === "local-loopback")
        return {
          ownerKind: "local-loopback",
          ownerId: "local-loopback",
        } satisfies ManagedAttachmentPrincipal;
      return yield* Effect.fail(new Error("The queued attachment has an invalid owner."));
    });
  const driver: SendDriver = {
    // Acceptance may precede turn.started in the durable stream. This keyed live binding closes that phase gap.
    isRunning: (threadId) =>
      directory.getBinding(ThreadId.makeUnsafe(threadId)).pipe(
        Effect.map((binding) => {
          if (Option.isNone(binding) || binding.value.status !== "running") return false;
          const payload = binding.value.runtimePayload;
          return (
            typeof payload === "object" &&
            payload !== null &&
            "activeTurnId" in payload &&
            typeof payload.activeTurnId === "string"
          );
        }),
      ),
    claimAttachments: (input) =>
      Effect.gen(function* () {
        const principal = yield* CurrentManagedAttachmentPrincipal;
        const attachmentIds = input.message.attachments
          .filter((attachment) => attachment.type !== "assistant-selection")
          .map((attachment) => attachment.id);
        const claim = yield* managedAttachments.claimForAcceptedTurn({
          attachmentIds,
          ownerThreadId: input.threadId,
          ownerKind: principal.ownerKind,
          ownerId: principal.ownerId,
          commandId: input.message.messageId,
          messageId: input.message.messageId,
          now: new Date().toISOString(),
        });
        if (claim.status !== "claimed")
          return yield* Effect.fail(
            new Error(`Managed attachment claim was rejected: ${claim.reason}.`),
          );
      }).pipe(
        Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))),
      ),
    dispatch: (input, mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const principal = yield* attachmentPrincipal(input);
          const threadId = ThreadId.makeUnsafe(input.threadId);
          const rows = yield* sql<{
            provider: string;
            model: string;
            runtimeMode: string;
            modelOptions: string | null;
            connectionId: ProviderConnectionId | null;
            workspaceRoot: string | null;
          }>`SELECT t.provider, t.model, t.model_options AS "modelOptions", t.runtime_mode AS "runtimeMode", t.connection_id AS "connectionId", f.workspace_root AS "workspaceRoot" FROM threads t JOIN projection_folders f ON f.folder_id = t.folder_id WHERE t.id = ${threadId}`;
          const row = rows[0];
          if (row === undefined) return yield* Effect.fail(new Error("The thread does not exist."));
          const { modelSelection, connectionId, runtimeMode } = resolveDraftSendSelection(
            { ...row, draft: null },
            input,
          );
          yield* coordinator.dispatchTurnStart({
            command: {
              threadId,
              message: {
                messageId: MessageId.makeUnsafe(input.message.messageId),
                text: input.message.text,
                attachments: input.message.attachments,
                ...(input.skills === undefined ? {} : { skills: input.skills }),
                ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
              },
              dispatchMode: mode === "deliver" ? "queue" : mode,
              modelSelection,
              connectionId,
              runtimeMode,
              ...(input.reviewTarget === undefined ? {} : { reviewTarget: input.reviewTarget }),
              ...(input.providerOptions === undefined
                ? {}
                : { providerOptions: input.providerOptions }),
              ...(input.assistantDeliveryMode === undefined
                ? {}
                : { assistantDeliveryMode: input.assistantDeliveryMode }),
              createdAt: new Date().toISOString(),
            },
            attachmentPrincipal: principal,
            cwd: row.workspaceRoot ?? ensureDurableThreadWorkspace(threadId, serverConfig.stateDir),
          });
        }),
      ),
  };
  const deliverHead = (threadId: string, retryFailedHead = false) =>
    Effect.gen(function* () {
      const request = yield* withLane(
        threadId,
        sql.withTransaction(
          Effect.gen(function* () {
            const [thread] = yield* sql<{
              state: string;
              queue: string;
              provider: string;
              model: string;
              runtimeMode: string;
              modelOptions: string | null;
              connectionId: ProviderConnectionId | null;
              draft: string | null;
              archivedAt: string | null;
              deletedAt: string | null;
            }>`
        SELECT state,queue,provider,model,runtime_mode AS "runtimeMode",model_options AS "modelOptions",connection_id AS "connectionId",draft,
        archived_at AS "archivedAt",deleted_at AS "deletedAt" FROM threads WHERE id=${threadId}`;
            if (
              thread === undefined ||
              thread.state === "running" ||
              (thread.state === "error" && !retryFailedHead) ||
              thread.archivedAt !== null ||
              thread.deletedAt !== null
            )
              return null;
            const pending =
              yield* sql`SELECT 1 FROM thread_items WHERE thread_id=${threadId} AND kind='user' AND status='sending' LIMIT 1`;
            if (pending.length > 0) return null;
            if (yield* driver.isRunning(threadId)) return null;
            const queue = decodeQueue(JSON.parse(thread.queue));
            const head = queue[0];
            if (head === undefined) return null;
            const input = {
              threadId,
              message: head,
              skills: head.skills,
              mentions: head.mentions,
              dispatchMode: "queue" as const,
              supportsSteer: providerSupportsNativeTurnSteering(thread.provider),
              ...resolveDraftSendSelection(thread),
            };
            const selected = yield* writeSendingMessage(
              input,
              "deliver",
              yield* attachmentPrincipal(input),
            );
            return selected.delivery;
          }),
        ),
      );
      if (request === null) return;
      publisher.publish({ threadId });
      yield* withLane(
        threadId,
        deliverMessage(publisher, driver, request.input, request.plan),
        "delivery",
      );
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const deliveryEvents = yield* PubSub.subscribe(publisher.deliveryReady);
  const providerEvents = yield* PubSub.subscribe(publisher.providerEvents);
  yield* Stream.fromEffectRepeat(PubSub.take(deliveryEvents)).pipe(
    Stream.runForEach((change) => Effect.forkIn(deliverHead(change.threadId), scope)),
    Effect.forkIn(scope),
  );
  yield* Stream.fromEffectRepeat(PubSub.take(providerEvents)).pipe(
    Stream.runForEach((event) =>
      event.type === "turn.ended"
        ? Effect.forkIn(deliverHead(event.threadId, true), scope)
        : Effect.void,
    ),
    Effect.forkIn(scope),
  );
  const removeQueued = (input: { threadId: ThreadId; messageId: string }) =>
    withLane(
      input.threadId,
      Effect.gen(function* () {
        const changed = yield* sql.withTransaction(
          Effect.gen(function* () {
            const queue = yield* readThreadQueue(input.threadId);
            const message = queue.find((message) => message.messageId === input.messageId);
            if (message === undefined) {
              const deleted = yield* sql`DELETE FROM thread_items WHERE thread_id=${input.threadId}
                AND source_id=${input.messageId} AND kind='user' AND status='failed' RETURNING seq`;
              if (deleted.length === 0) return null;
              yield* sql`UPDATE threads SET last_message_preview=(SELECT text FROM thread_items WHERE thread_id=${input.threadId}
                AND kind IN ('user','text') AND (kind<>'user' OR COALESCE(json_extract(data,'$.origin._tag'),'')<>'recovery') ORDER BY seq DESC LIMIT 1),
                last_user_message_at=(SELECT created_at FROM thread_items WHERE thread_id=${input.threadId} AND kind='user' AND COALESCE(json_extract(data,'$.origin._tag'),'')<>'recovery' ORDER BY seq DESC LIMIT 1),
                updated_at=${new Date().toISOString()} WHERE id=${input.threadId}`;
              return { wasHead: false };
            }
            const remaining = queue.filter((message) => message.messageId !== input.messageId);
            yield* sql`UPDATE threads SET queue = ${JSON.stringify(remaining)}, updated_at = ${new Date().toISOString()} WHERE id = ${input.threadId}`;
            return { wasHead: queue[0]?.messageId === input.messageId };
          }),
        );
        if (changed !== null) {
          publisher.publish({ threadId: input.threadId });
          if (changed.wasHead) yield* Effect.forkIn(deliverHead(input.threadId, true), scope);
        }
        return { ...input, removed: changed !== null };
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    );
  const getRuntime = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        state: string;
        activeTurnId: string | null;
      }>`SELECT state, active_turn_id AS "activeTurnId" FROM threads WHERE id = ${threadId}`;
      if (rows[0] === undefined) return yield* Effect.fail(new Error("The thread does not exist."));
      return Schema.decodeUnknownSync(CleanCoreThreadRuntime)(rows[0]);
    });
  return {
    resumeQueuedForConnection: (connectionId: ProviderConnectionId) =>
      Effect.gen(function* () {
        let after = "";
        while (true) {
          const rows = yield* sql<{
            id: string;
          }>`SELECT id FROM threads WHERE connection_id=${connectionId} AND id>${after} AND deleted_at IS NULL AND archived_at IS NULL ORDER BY id LIMIT 50`;
          for (const row of rows) yield* Effect.forkIn(deliverHead(row.id, true), scope);
          if (rows.length < 50) return;
          after = rows[rows.length - 1]!.id;
        }
      }).pipe(
        Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
      ),
    runExclusive: <A, E, R>(threadId: ThreadId, action: Effect.Effect<A, E, R>) =>
      withLane(threadId, withLane(threadId, action, "delivery")),
    queuedThread: (messageId: string) =>
      Effect.gen(function* () {
        let after: string | null = null;
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
          for (const row of page) {
            if (
              decodeQueue(JSON.parse(row.queue)).some((message) => message.messageId === messageId)
            )
              return ThreadId.makeUnsafe(row.id);
            const failed =
              yield* sql`SELECT 1 FROM thread_items WHERE thread_id=${row.id} AND source_id=${messageId} AND kind='user' AND status='failed'`;
            if (failed.length) return ThreadId.makeUnsafe(row.id);
          }
          if (page.length < 50) return null;
          after = page[page.length - 1]!.id;
        }
      }),
    cancelQueued: (input: { threadId: ThreadId; messageId: string }) => removeQueued(input),
    editQueued: (input: { threadId: ThreadId; messageId: string; updatedAt: string }) =>
      withLane(
        input.threadId,
        Effect.gen(function* () {
          const result = yield* moveIntoDraft("queue", input);
          if (result.removed) {
            publisher.publish({ threadId: input.threadId });
            if (result.wasHead) yield* Effect.forkIn(deliverHead(input.threadId, true), scope);
          }
          return result;
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
    savePrompt: (input: CleanCoreSavePromptInput) =>
      withLane(
        input.threadId,
        savePrompt(input, driver.claimAttachments).pipe(
          Effect.tap(() => Effect.sync(() => publisher.publish({ threadId: input.threadId }))),
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      ),
    restoreSavedPrompt: (input: { threadId: ThreadId; messageId: string; updatedAt: string }) =>
      withLane(
        input.threadId,
        moveIntoDraft("saved", input).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              if (result.removed) publisher.publish({ threadId: input.threadId });
            }),
          ),
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      ),
    deleteSavedPrompt: (input: { threadId: ThreadId; messageId: string }) =>
      withLane(
        input.threadId,
        deleteSavedPrompt(input).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              if (result.removed) publisher.publish({ threadId: input.threadId });
            }),
          ),
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
      ),
    getRuntime,
    interrupt: (threadId: ThreadId) =>
      withLane(
        threadId,
        Effect.gen(function* () {
          const runtime = yield* getRuntime(threadId);
          const nativeState = provider.getRuntimeState(threadId);
          const nativeBusy = nativeState === "starting" || nativeState === "running";
          if (runtime.state !== "running" && !nativeBusy)
            return { threadId, interruptRequested: false, interruptedTurnId: null };
          if (runtime.activeTurnId === null && !nativeBusy)
            return yield* Effect.fail(new Error("The running thread has no active provider turn."));
          yield* provider.interruptTurn({ threadId });
          return { threadId, interruptRequested: true, interruptedTurnId: runtime.activeTurnId };
        }),
      ),
    steerQueued: (input: CleanCoreQueuedMessageInput, callerThreadId?: ThreadId) =>
      withLane(
        input.threadId,
        Effect.gen(function* () {
          const result = yield* sql.withTransaction(
            Effect.gen(function* () {
              const [thread] = yield* sql<{
                provider: string;
                model: string;
                runtimeMode: string;
                modelOptions: string | null;
                connectionId: ProviderConnectionId | null;
                state: string;
                archivedAt: string | null;
                deletedAt: string | null;
              }>`SELECT provider,model,runtime_mode AS "runtimeMode",model_options AS "modelOptions",
              connection_id AS "connectionId",state,archived_at AS "archivedAt",deleted_at AS "deletedAt"
              FROM threads WHERE id=${input.threadId}`;
              if (!thread || thread.deletedAt !== null)
                return yield* Effect.fail(new Error("The thread does not exist."));
              if (thread.archivedAt !== null)
                return yield* Effect.fail(
                  new Error("This thread is archived. Unarchive it to steer a queued message."),
                );
              const queue = yield* readThreadQueue(input.threadId);
              const message = queue.find((entry) => entry.messageId === input.messageId);
              if (!message)
                return yield* Effect.fail(new Error("The message is no longer queued."));
              if (
                callerThreadId !== undefined &&
                (message.origin._tag !== "agent" ||
                  message.origin.senderThreadId !== callerThreadId)
              )
                return yield* Effect.fail(
                  new Error("An agent may steer only a message its own thread queued."),
                );
              const [existing] = yield* sql<{
                seq: number;
                plan: "deliver" | "steer" | "interrupt-deliver";
              }>`
              SELECT seq,admission_plan AS plan FROM thread_items WHERE thread_id=${input.threadId}
                AND source_id=${input.messageId} AND kind='user' AND status='sending'`;
              if (existing)
                return {
                  admission: {
                    ...input,
                    plan: existing.plan,
                    seq: existing.seq,
                  },
                  delivery: null,
                };
              const pendingPrefix = yield* sql`SELECT 1 FROM thread_items
                WHERE thread_id=${input.threadId} AND kind='user' AND status='sending'
                  AND json_extract(send_payload,'$.deliveryRequestId')=${input.messageId} LIMIT 1`;
              if (pendingPrefix.length)
                return {
                  admission: {
                    ...input,
                    plan: "queue" as const,
                    position: queue.findIndex((entry) => entry.messageId === input.messageId) + 1,
                    queueLength: queue.length,
                  },
                  delivery: null,
                };
              const running =
                thread.state === "running" || (yield* driver.isRunning(input.threadId));
              const plan = running
                ? providerSupportsNativeTurnSteering(thread.provider)
                  ? ("steer" as const)
                  : ("interrupt-deliver" as const)
                : ("deliver" as const);
              const selected = yield* writeSendingMessage(
                {
                  threadId: input.threadId,
                  message,
                  skills: message.skills,
                  mentions: message.mentions,
                  dispatchMode: "steer",
                  supportsSteer: providerSupportsNativeTurnSteering(thread.provider),
                  ...resolveDraftSendSelection({ ...thread, draft: null }),
                },
                plan,
                yield* attachmentPrincipal({
                  threadId: input.threadId,
                  message,
                  dispatchMode: "steer",
                  supportsSteer: false,
                }),
              );
              return {
                admission: selected.includesRequested
                  ? { ...input, plan: selected.delivery.plan, seq: selected.seq }
                  : {
                      ...input,
                      plan: "queue" as const,
                      position: 1,
                      queueLength: selected.queueLength,
                    },
                delivery: selected.delivery,
              };
            }),
          );
          publisher.publish({ threadId: input.threadId });
          if (result.delivery !== null) {
            const delivery = result.delivery;
            yield* Effect.forkIn(
              withLane(
                input.threadId,
                deliverMessage(publisher, driver, delivery.input, delivery.plan).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                ),
                "delivery",
              ),
              scope,
            );
          }
          return result.admission;
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
    send: (input: ThreadSendInput) =>
      withLane(
        input.threadId,
        Effect.gen(function* () {
          const [current] = yield* sql<{
            provider: string;
            model: string;
            runtimeMode: string;
            modelOptions: string | null;
            connectionId: ProviderConnectionId | null;
            draft: string | null;
            state: string;
            activeTurnId: string | null;
          }>`SELECT provider,model,runtime_mode AS "runtimeMode",model_options AS "modelOptions",connection_id AS "connectionId",
        draft,state,active_turn_id AS "activeTurnId" FROM threads WHERE id=${input.threadId}`;
          if (current === undefined)
            return yield* Effect.fail(new Error("The thread does not exist."));
          const selection = resolveDraftSendSelection(current, input);
          const request = {
            ...input,
            ...selection,
            supportsSteer:
              providerSupportsNativeTurnSteering(current.provider) &&
              selection.connectionId === current.connectionId,
          };
          const { admission, delivery } = yield* sendMessage(publisher, driver, request);
          if (delivery === null && admission.plan === "queue") {
            if (current.state !== "running")
              yield* Effect.forkIn(deliverHead(input.threadId, true), scope);
          } else if (delivery !== null) {
            yield* Effect.forkIn(
              withLane(
                input.threadId,
                deliverMessage(publisher, driver, delivery.input, delivery.plan).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                ),
                "delivery",
              ),
              scope,
            );
          }
          return admission;
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
  };
});
export const ThreadSenderLive = Layer.effect(
  ThreadSender,
  Effect.gen(function* () {
    const sender = yield* makeThreadSender;
    const circuits = yield* ProviderAuthCircuits;
    const sql = yield* SqlClient.SqlClient;
    const publisher = yield* ThreadPublisher;
    const releases = yield* circuits.subscribeReleases;
    yield* Stream.runForEach(Stream.fromSubscription(releases), (circuit) =>
      Effect.gen(function* () {
        const changed =
          yield* sql`UPDATE threads SET state=CASE WHEN state='error' THEN 'idle' ELSE state END,last_error=NULL
      WHERE connection_id=${circuit.connectionId} AND last_error LIKE ${circuit.summary + "%"} RETURNING id`;
        for (const row of changed) publisher.publish({ threadId: String(row.id) });
        yield* sender.resumeQueuedForConnection(circuit.connectionId);
      }),
    ).pipe(Effect.orDie, Effect.forkScoped);
    return sender;
  }),
);
