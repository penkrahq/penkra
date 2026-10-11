import { ServerConfig } from "../config.ts";
import { ensureDurableThreadWorkspace } from "../scratchWorkspaces.ts";
import { ManagedAttachmentRepository } from "../persistence/Services/ManagedAttachments.ts";
import { randomUUID } from "node:crypto";
import {
  CommandId,
  MessageId,
  ModelSelection,
  RuntimeMode,
  ThreadId,
  TurnId,
  CleanCoreThreadRuntime,
  QUEUED_MESSAGE_EDIT_NONEMPTY_DRAFT_ERROR,
  QueuedEditDraftNotEmptyError,
  type CleanCoreInterruptResult,
  type CleanCoreSendResult,
  ProviderConnectionId,
  type CleanCoreSendMessageInput,
  ProviderKind,
  type OrchestrationThread,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@penkra/contracts";
import { Deferred, Effect, Layer, Option, Schema, Semaphore, ServiceMap } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderThreadSwitchCoordinator } from "../orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ThreadProviderBindingRepository } from "../persistence/Services/ThreadProviderBindings.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  CurrentManagedAttachmentPrincipal,
  type ManagedAttachmentPrincipal,
} from "../managedAttachmentPrincipal.ts";
import { setThreadState } from "./threadStore.ts";
import { ThreadPublisher } from "./ThreadPublisher.ts";
import { DraftSelection } from "./threadDraft.ts";
import { deliverMessage, sendMessage, type SendDriver } from "./sendMessage.ts";
import { readThreadQueue, QueuedMessage } from "./threadQueue.ts";
import { providerSupportsNativeTurnSteering } from "@penkra/shared/providerMetadata";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterValidationError } from "../provider/Errors.ts";
import {
  formatReconstructedContinuation,
  selectReconstructedContinuation,
} from "../provider/reconstructedContinuation.ts";

export const buildReconstructedTurnInput = Effect.fnUntraced(function* (
  input: {
    readonly threadId: ThreadId;
    readonly provider: ProviderKind;
    readonly currentMessageId: string;
    readonly currentInput: string;
  },
  projectionSnapshotQuery: typeof ProjectionSnapshotQuery.Service,
) {
  const messages: OrchestrationThread["messages"][number][] = [];
  const activities: OrchestrationThread["activities"][number][] = [];
  let before: string | undefined;
  let foundCompaction = false;
  do {
    const page = yield* projectionSnapshotQuery.getThreadTurnsPage({
      threadId: input.threadId,
      ...(before ? { before } : {}),
    });
    messages.push(...page.messages);
    activities.push(...page.activities);
    foundCompaction = page.activities.some((activity) => activity.kind === "context-compaction");
    if (foundCompaction || !page.hasOlder || page.nextCursor === null) break;
    before = page.nextCursor;
  } while (true);

  const hasPriorTranscript = messages.some((message) => message.id !== input.currentMessageId);
  if (!hasPriorTranscript && !foundCompaction) return null;
  const continuation = selectReconstructedContinuation({
    messages,
    activities,
    currentMessageId: input.currentMessageId,
  });
  const reconstructed = formatReconstructedContinuation({
    threadId: input.threadId,
    continuation,
    currentInput: input.currentInput,
  });
  if (reconstructed.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
    return yield* new ProviderAdapterValidationError({
      provider: input.provider,
      operation: "thread.turn.reconstruct",
      issue: `The deterministic retained transcript is ${reconstructed.length} characters, exceeding the provider input limit of ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS}. Penkra did not trim or discard it.`,
    });
  }
  return reconstructed;
});

export type ThreadSendInput = CleanCoreSendMessageInput;
export class ThreadSender extends ServiceMap.Service<
  ThreadSender,
  {
    readonly runExclusive: <A, E, R>(
      threadId: ThreadId,
      action: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly send: (input: ThreadSendInput) => Effect.Effect<CleanCoreSendResult, Error>;
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
  const bindings = yield* ThreadProviderBindingRepository;
  const provider = yield* ProviderService;
  const managedAttachments = yield* ManagedAttachmentRepository;
  const decodeDraftSelection = Schema.decodeUnknownSync(DraftSelection);
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
      const queued = yield* readThreadQueue(input.threadId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const attachment = input.message.attachments.find(
        (attachment) => attachment.type !== "assistant-selection",
      );
      if (
        attachment === undefined ||
        !queued.some((message) => message.messageId === input.message.messageId)
      )
        return yield* CurrentManagedAttachmentPrincipal;
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
        const principal = yield* attachmentPrincipal(input);
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
    interrupt: (threadId) =>
      provider.interruptTurn({ threadId: ThreadId.makeUnsafe(threadId) }).pipe(Effect.asVoid),
    dispatch: (input, mode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const principal = yield* attachmentPrincipal(input);
          const threadId = ThreadId.makeUnsafe(input.threadId);
          const rows = yield* sql<{
            provider: string;
            model: string;
            modelOptions: string | null;
            runtimeMode: string;
            connectionId: ProviderConnectionId | null;
            workspaceRoot: string | null;
            draft: string | null;
          }>`SELECT t.draft, t.provider, t.model, t.model_options AS "modelOptions", t.runtime_mode AS "runtimeMode", t.connection_id AS "connectionId", f.workspace_root AS "workspaceRoot" FROM threads t JOIN projection_folders f ON f.folder_id = t.folder_id WHERE t.id = ${threadId}`;
          const row = rows[0];
          if (row === undefined) return yield* Effect.fail(new Error("The thread does not exist."));
          const draft = row.draft === null ? {} : decodeDraftSelection(JSON.parse(row.draft));
          const modelSelection =
            input.modelSelection ??
            draft.modelSelectionByProvider?.[
              Schema.decodeUnknownSync(ProviderKind)(row.provider)
            ] ??
            Schema.decodeUnknownSync(ModelSelection)({
              provider: row.provider,
              model: row.model,
              ...(row.modelOptions === null ? {} : { options: JSON.parse(row.modelOptions) }),
            });
          const draftConnection = draft.connectionSelectionByProvider?.[modelSelection.provider];
          const connectionId =
            input.connectionId !== undefined
              ? input.connectionId
              : draftConnection !== undefined
                ? draftConnection
                : row.connectionId;
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
                ...(input.skills === undefined ? {} : { skills: input.skills }),
                ...(input.mentions === undefined ? {} : { mentions: input.mentions }),
              },
              dispatchMode: mode === "steer" ? "steer" : "queue",
              dispatchOrigin: input.message.dispatchOrigin,
              ...(input.message.senderThreadId === null
                ? {}
                : { senderThreadId: input.message.senderThreadId }),
              modelSelection,
              connectionId,
              runtimeMode,
              ...(input.providerOptions === undefined
                ? {}
                : { providerOptions: input.providerOptions }),
              ...(input.assistantDeliveryMode === undefined
                ? {}
                : { assistantDeliveryMode: input.assistantDeliveryMode }),
              bindingRevision: Option.isSome(binding) ? binding.value.revision : 0,
              createdAt: new Date().toISOString(),
            },
            attachmentPrincipal: principal,
            cwd: row.workspaceRoot ?? ensureDurableThreadWorkspace(threadId, serverConfig.stateDir),
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
  const deliverHead = (threadId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        state: string;
        queue: string;
        provider: string;
        archivedAt: string | null;
        deletedAt: string | null;
      }>`SELECT state, queue, provider, archived_at AS "archivedAt", deleted_at AS "deletedAt" FROM threads WHERE id = ${threadId}`;
      const thread = rows[0];
      if (
        thread === undefined ||
        thread.state === "running" ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null
      )
        return;
      const queue = decodeQueue(JSON.parse(thread.queue));
      const head = queue[0];
      if (head === undefined) return;
      const result = yield* deliverMessage(
        publisher,
        driver,
        {
          threadId,
          message: head,
          dispatchMode: "queue",
          supportsSteer: providerSupportsNativeTurnSteering(thread.provider),
        },
        "deliver",
        null,
      );
      if (result.delivery === "failed") {
        yield* setThreadState(threadId, "error", null, result.error, new Date().toISOString());
        publisher.publish({ threadId });
        return;
      }
      const remaining = queue.slice(1);
      yield* sql`UPDATE threads SET queue = ${JSON.stringify(remaining)}, updated_at = ${new Date().toISOString()} WHERE id = ${threadId}`;
      publisher.publish({ threadId });
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  const unsubscribe = publisher.subscribeProvider((event) => {
    const threadIds =
      event.type === "turn.ended"
        ? [event.threadId]
        : event.type === "provider.exited"
          ? event.threadIds
          : [];
    for (const threadId of threadIds)
      Effect.runSync(Effect.forkIn(withLane(threadId, deliverHead(threadId)), scope));
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
            if (message === undefined) return null;
            const remaining = queue.filter((message) => message.messageId !== input.messageId);
            if (draftUpdatedAt === null)
              yield* sql`UPDATE threads SET queue = ${JSON.stringify(remaining)}, updated_at = ${new Date().toISOString()} WHERE id = ${input.threadId}`;
            else {
              const stored = yield* sql<{
                draft: string | null;
              }>`SELECT draft FROM threads WHERE id = ${input.threadId}`;
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
              yield* sql`UPDATE threads SET queue = ${JSON.stringify(remaining)}, draft = ${draft}, draft_updated_at = ${draftUpdatedAt}, updated_at = ${draftUpdatedAt} WHERE id = ${input.threadId}`;
            }
            return { wasHead: queue[0]?.messageId === input.messageId };
          }),
        );
        if (changed !== null) {
          publisher.publish({ threadId: input.threadId });
          if (changed.wasHead)
            yield* Effect.forkIn(withLane(input.threadId, deliverHead(input.threadId)), scope);
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
  const readConfirmation = (input: ThreadSendInput) =>
    Effect.gen(function* () {
      const delivered = yield* sql<{
        turnId: string;
        data: string;
      }>`SELECT turn_id AS "turnId", data FROM thread_items WHERE thread_id = ${input.threadId} AND source_id = ${input.message.messageId} AND kind = 'user' AND status = 'sent'`;
      if (delivered[0] === undefined) return null;
      const confirmation = Schema.decodeUnknownSync(
        Schema.Struct({ delivery: Schema.Literals(["started", "steered", "interrupted"]) }),
      )(JSON.parse(delivered[0].data));
      return {
        threadId: input.threadId,
        messageId: input.message.messageId,
        delivery: confirmation.delivery,
        turnId: Schema.decodeUnknownSync(TurnId)(delivered[0].turnId),
      };
    });
  return {
    runExclusive: withLane,
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
          const delivered = yield* readConfirmation(input);
          if (delivered !== null) return delivered;
          const currentRows = yield* sql<{
            provider: string;
            connectionId: ProviderConnectionId | null;
            draft: string | null;
            state: string;
            archivedAt: string | null;
            deletedAt: string | null;
          }>`SELECT provider, connection_id AS "connectionId", draft, state, archived_at AS "archivedAt", deleted_at AS "deletedAt" FROM threads WHERE id = ${input.threadId}`;
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
          if (current.state !== "running") yield* deliverHead(input.threadId);
          const retried = yield* readConfirmation(input);
          if (retried !== null) return retried;
          const queue = yield* readThreadQueue(input.threadId);
          const position = queue.findIndex(
            (message) => message.messageId === input.message.messageId,
          );
          if (position !== -1 && (input.dispatchMode === "queue" || current.state !== "running")) {
            const runtime = yield* getRuntime(input.threadId);
            return {
              threadId: input.threadId,
              messageId: input.message.messageId,
              delivery: "queued" as const,
              position: position + 1,
              queueLength: queue.length,
              runningTurnId: runtime.activeTurnId,
            };
          }
          const draftSelection =
            current.draft === null ? {} : decodeDraftSelection(JSON.parse(current.draft));
          const selectedConnectionId =
            input.connectionId !== undefined
              ? input.connectionId
              : draftSelection.connectionSelectionByProvider?.[
                  Schema.decodeUnknownSync(ProviderKind)(current.provider)
                ];
          const result = yield* sendMessage(publisher, driver, {
            ...input,
            message: position === -1 ? input.message : queue[position]!,
            dispatchMode: current.state === "running" ? input.dispatchMode : "queue",
            supportsSteer:
              providerSupportsNativeTurnSteering(row.provider) &&
              (selectedConnectionId === undefined || selectedConnectionId === current.connectionId),
          });
          if (position !== -1 && result.delivery !== "failed" && result.delivery !== "queued") {
            yield* sql`UPDATE threads SET queue = ${JSON.stringify(queue.filter((message) => message.messageId !== input.message.messageId))} WHERE id = ${input.threadId}`;
            publisher.publish({ threadId: input.threadId });
          }
          return result;
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
  };
});
export const ThreadSenderLive = Layer.effect(ThreadSender, makeThreadSender);
