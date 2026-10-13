import { ProviderAuthCircuits } from "../provider/providerAuthCircuit.ts";
import { ServerConfig } from "../config.ts";
import { ensureDurableThreadWorkspace } from "../scratchWorkspaces.ts";
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments.ts";
import {} from "node:crypto";
import {
  MessageId,
  ThreadId,
  CleanCoreThreadRuntime,
  QUEUED_MESSAGE_EDIT_NONEMPTY_DRAFT_ERROR,
  QueuedEditDraftNotEmptyError,
  type CleanCoreInterruptResult,
  type CleanCoreSendAdmission,
  ProviderConnectionId,
  type CleanCoreSendMessageInput,
} from "@penkra/contracts";
import { Deferred, Effect, Layer, Option, Schema, Semaphore, ServiceMap, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderThreadSwitchCoordinator } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  CurrentManagedAttachmentPrincipal,
  type ManagedAttachmentPrincipal,
} from "../managedAttachmentPrincipal.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { nextCommittedDraftTimestamp } from "./threadDraftTimestamp.ts";
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
    readonly interrupt: (threadId: ThreadId) => Effect.Effect<CleanCoreInterruptResult, Error>;
  }
>()("penkra/cleanCore/ThreadSender") {}

export const makeThreadSender = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const serverConfig = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;
  const publisher = yield* ThreadPublisher;
  const coordinator = yield* ProviderThreadSwitchCoordinator;
  const provider = yield* ProviderService;
  const managedAttachments = yield* ManagedAttachmentRepository;
  const decodeDraftContent = Schema.decodeUnknownSync(
    Schema.Struct({
      prompt: Schema.String,
      attachments: Schema.Array(Schema.Unknown),
      files: Schema.Array(Schema.Unknown),
    }),
  );
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
            draft: string | null;
          }>`SELECT t.draft, t.provider, t.model, t.model_options AS "modelOptions", t.runtime_mode AS "runtimeMode", t.connection_id AS "connectionId", f.workspace_root AS "workspaceRoot" FROM threads t JOIN projection_folders f ON f.folder_id = t.folder_id WHERE t.id = ${threadId}`;
          const row = rows[0];
          if (row === undefined) return yield* Effect.fail(new Error("The thread does not exist."));
          const { modelSelection, connectionId, runtimeMode } = resolveDraftSendSelection(
            row,
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
              dispatchMode: mode === "deliver" ? "queue" : "steer",
              origin: input.message.origin,
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
  const lanes = new Map<
    string,
    { admission: Semaphore.Semaphore; delivery: Semaphore.Semaphore; users: number }
  >();
  const withLane = <A, E, R>(
    threadId: string,
    action: Effect.Effect<A, E, R>,
    kind: "admission" | "delivery" = "admission",
  ) =>
    Effect.suspend(() => {
      let lane = lanes.get(threadId);
      if (lane === undefined) {
        lane = { admission: Semaphore.makeUnsafe(1), delivery: Semaphore.makeUnsafe(1), users: 0 };
        lanes.set(threadId, lane);
      }
      lane.users += 1;
      const acquired = lane;
      return acquired[kind]
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
  const waitForPendingAdmission = (threadId: string) =>
    Effect.gen(function* () {
      while (
        yield* Effect.scoped(
          Effect.gen(function* () {
            const changed = yield* Deferred.make<void>();
            const unsubscribe = publisher.subscribe(threadId, () =>
              Effect.runSync(Deferred.succeed(changed, undefined)),
            );
            yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
            const pending = yield* sql`SELECT 1 FROM thread_items WHERE thread_id=${threadId}
        AND kind='user' AND status='sending' LIMIT 1`;
            if (pending.length === 0) return false;
            yield* Deferred.await(changed);
            return true;
          }),
        )
      ) {}
    });
  const deliverHead = (threadId: string) =>
    Effect.gen(function* () {
      yield* waitForPendingAdmission(threadId);
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
              thread.archivedAt !== null ||
              thread.deletedAt !== null
            )
              return null;
            const pending =
              yield* sql`SELECT 1 FROM thread_items WHERE thread_id=${threadId} AND kind='user' AND status='sending' LIMIT 1`;
            if (pending.length > 0) return null;
            const queue = decodeQueue(JSON.parse(thread.queue));
            const head = queue[0];
            if (head === undefined) return null;
            const input = {
              threadId,
              message: head,
              dispatchMode: "queue" as const,
              supportsSteer: providerSupportsNativeTurnSteering(thread.provider),
              ...resolveDraftSendSelection(thread),
            };
            yield* writeSendingMessage(input, "deliver", yield* attachmentPrincipal(input));
            return input;
          }),
        ),
      );
      if (request === null) return;
      publisher.publish({ threadId });
      yield* withLane(threadId, deliverMessage(publisher, driver, request, "deliver"), "delivery");
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const unsubscribe = publisher.subscribeProvider((event) => {
    const threadIds = event.type === "turn.ended" ? [event.threadId] : [];
    for (const threadId of threadIds) Effect.runSync(Effect.forkIn(deliverHead(threadId), scope));
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  const removeQueued = (
    input: { threadId: ThreadId; messageId: string },
    draftUpdatedAt: string | null,
  ) =>
    withLane(
      input.threadId,
      Effect.gen(function* () {
        const changed = yield* sql.withTransaction(
          Effect.gen(function* () {
            const queue = yield* readThreadQueue(input.threadId);
            const message = queue.find((message) => message.messageId === input.messageId);
            if (message === undefined) {
              if (draftUpdatedAt !== null) return null;
              const deleted = yield* sql`DELETE FROM thread_items WHERE thread_id=${input.threadId}
                AND source_id=${input.messageId} AND kind='user' AND status='failed' RETURNING seq`;
              if (deleted.length === 0) return null;
              yield* sql`UPDATE threads SET last_message_preview=(SELECT text FROM thread_items WHERE thread_id=${input.threadId}
                AND kind IN ('user','text') ORDER BY seq DESC LIMIT 1),
                last_user_message_at=(SELECT created_at FROM thread_items WHERE thread_id=${input.threadId} AND kind='user' ORDER BY seq DESC LIMIT 1),
                updated_at=${new Date().toISOString()} WHERE id=${input.threadId}`;
              return { wasHead: false };
            }
            const remaining = queue.filter((message) => message.messageId !== input.messageId);
            if (draftUpdatedAt === null)
              yield* sql`UPDATE threads SET queue = ${JSON.stringify(remaining)}, updated_at = ${new Date().toISOString()} WHERE id = ${input.threadId}`;
            else {
              const stored = yield* sql<{
                draft: string | null;
                draftUpdatedAt: string | null;
              }>`SELECT draft,draft_updated_at AS "draftUpdatedAt" FROM threads WHERE id = ${input.threadId}`;
              if (stored[0]!.draft !== null) {
                const content = decodeDraftContent(JSON.parse(stored[0]!.draft));
                if (
                  content.prompt.length > 0 ||
                  content.attachments.length > 0 ||
                  content.files.length > 0
                )
                  return yield* Effect.fail(
                    new QueuedEditDraftNotEmptyError({
                      message: QUEUED_MESSAGE_EDIT_NONEMPTY_DRAFT_ERROR,
                    }),
                  );
              }
              const reference = (attachment: { id: string; name: string; mimeType: string }) => ({
                id: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
              });
              const draft = JSON.stringify({
                ...(stored[0]!.draft === null ? {} : JSON.parse(stored[0]!.draft)),
                prompt: message.text,
                attachments: message.attachments.filter((a) => a.type === "image").map(reference),
                files: message.attachments.filter((a) => a.type === "file").map(reference),
                assistantSelections: message.attachments.filter(
                  (a) => a.type === "assistant-selection",
                ),
              });
              const committedAt = nextCommittedDraftTimestamp(
                stored[0]!.draftUpdatedAt,
                draftUpdatedAt,
              );
              yield* sql`UPDATE threads SET queue = ${JSON.stringify(remaining)}, draft = ${draft}, draft_updated_at = ${committedAt}, updated_at = ${committedAt} WHERE id = ${input.threadId}`;
            }
            return { wasHead: queue[0]?.messageId === input.messageId };
          }),
        );
        if (changed !== null) {
          publisher.publish({ threadId: input.threadId });
          if (changed.wasHead) yield* Effect.forkIn(deliverHead(input.threadId), scope);
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
          for (const row of rows) yield* Effect.forkIn(deliverHead(row.id), scope);
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
    cancelQueued: (input: { threadId: ThreadId; messageId: string }) => removeQueued(input, null),
    editQueued: (input: { threadId: ThreadId; messageId: string; updatedAt: string }) =>
      removeQueued({ threadId: input.threadId, messageId: input.messageId }, input.updatedAt),
    getRuntime,
    interrupt: (threadId: ThreadId) =>
      withLane(
        threadId,
        Effect.gen(function* () {
          const runtime = yield* getRuntime(threadId);
          if (runtime.state !== "running")
            return { threadId, interruptRequested: false, interruptedTurnId: null };
          if (runtime.activeTurnId === null)
            return yield* Effect.fail(new Error("The running thread has no active provider turn."));
          yield* provider.interruptTurn({ threadId });
          return { threadId, interruptRequested: true, interruptedTurnId: runtime.activeTurnId };
        }),
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
          const [existing] = yield* sql`SELECT 1 FROM thread_items WHERE thread_id=${input.threadId}
        AND source_id=${input.message.messageId} AND kind='user'`;
          const request = {
            ...input,
            ...selection,
            supportsSteer:
              providerSupportsNativeTurnSteering(current.provider) &&
              selection.connectionId === current.connectionId,
          };
          const admission = yield* sendMessage(publisher, driver, request);
          if (admission.plan === "queue") {
            if (current.state !== "running")
              yield* Effect.forkIn(deliverHead(input.threadId), scope);
          } else if (existing === undefined) {
            yield* Effect.forkIn(
              withLane(
                input.threadId,
                deliverMessage(publisher, driver, request, admission.plan).pipe(
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
