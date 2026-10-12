import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
} from "@penkra/contracts";
import { EventId, TurnId } from "@penkra/contracts";
import { collectTailTurnIds } from "@penkra/shared/conversationRollback";
import { Effect } from "effect";

import { canContinueLatestTurn } from "@penkra/shared/turnContinuation";
import { providerSupportsNativeTurnSteering } from "@penkra/shared/providerMetadata";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { resolveStableMessageTurnId } from "./messageTurnId.ts";
import {
  requireThread,
  requireThreadCanTakeWork,
  threadHasInFlightTurn,
} from "./commandInvariants.ts";

const nowIso = () => new Date().toISOString();
const DEFAULT_ASSISTANT_DELIVERY_MODE = "buffered" as const;
export const CONNECTION_CHANGED_ACTIVITY_KIND = "connection-changed";
export const MODEL_CHANGED_ACTIVITY_KIND = "model-changed";

/**
 * Server-trusted result of Connection preflight. This is deliberately not a
 * field on the public command schema: clients may request a Connection, but
 * only the server may state that the switch was verified and committed.
 */
export interface AcceptedConnectionChange {
  readonly previousConnectionId: string | null;
  readonly connectionId: string | null;
  readonly label: string;
  readonly previousModelId: string | null;
  readonly modelId: string;
  readonly modelLabel: string;
}
const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "thread",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

function deriveConversationRollbackTarget(
  messages: OrchestrationReadModel["threads"][number]["messages"],
  messageId: string,
): {
  readonly role: OrchestrationReadModel["threads"][number]["messages"][number]["role"];
  readonly removedTurnIds: ReadonlySet<string>;
} | null {
  const targetIndex = messages.findIndex((message) => message.id === messageId);
  if (targetIndex < 0) {
    return null;
  }

  return {
    role: messages[targetIndex]!.role,
    removedTurnIds: new Set(collectTailTurnIds({ messages, messageId })),
  };
}

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
  workspacePaths: _workspacePaths,
  acceptedConnectionChange,
  allowArchivedProviderProjection = false,
  userStopRequested = false,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly workspacePaths?:
    | { readonly homeDir: string; readonly chatWorkspaceRoot: string }
    | undefined;
  readonly acceptedConnectionChange?: AcceptedConnectionChange | undefined;
  readonly allowArchivedProviderProjection?: boolean;
  readonly userStopRequested?: boolean;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "thread.turn.recover": {
      const thread = yield* requireThreadCanTakeWork({
        readModel,
        command,
        threadId: command.threadId,
      }).pipe(
        Effect.mapError((error) =>
          command.reason === "play" && error.code !== "thread_archived"
            ? new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Thread changed before continuation.",
                code: "THREAD_CONTINUE_STALE",
              })
            : error,
        ),
      );
      if (
        command.reason === "play" &&
        (command.interruptedTurnId === undefined ||
          command.turnId !== command.interruptedTurnId ||
          !canContinueLatestTurn(thread, command.interruptedTurnId))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Thread changed before continuation.",
          code: "THREAD_CONTINUE_STALE",
        });
      }
      if (threadHasInFlightTurn(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has a turn in flight.`,
        });
      }
      if (
        command.interruptedTurnId !== undefined &&
        (thread.latestTurn?.turnId !== command.interruptedTurnId ||
          (thread.latestTurn.state !== "interrupted" && thread.latestTurn.state !== "error"))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Turn '${command.interruptedTurnId}' is no longer the restart-recoverable latest turn.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId ?? TurnId.makeUnsafe(`turn:${command.commandId}`),
          messageId: command.recoveryMessageId,
          recoveryReason: command.reason ?? "restart",
          connectionId: command.connectionId,
          assistantDeliveryMode: DEFAULT_ASSISTANT_DELIVERY_MODE,
          dispatchMode: "queue",
          dispatchOrigin: "automation",
          runtimeMode: command.runtimeMode,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThreadCanTakeWork({
        readModel,
        command,
        threadId: command.threadId,
      });
      const dispatchMode = command.dispatchMode ?? "queue";
      const turnId = command.turnId ?? TurnId.makeUnsafe(`turn:${command.commandId}`);
      const connectionChangedEvent: Omit<OrchestrationEvent, "sequence"> | null =
        acceptedConnectionChange === undefined ||
        acceptedConnectionChange.connectionId === null ||
        acceptedConnectionChange.connectionId === acceptedConnectionChange.previousConnectionId
          ? null
          : {
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              }),
              type: "thread.activity-appended",
              payload: {
                threadId: command.threadId,
                activity: {
                  id: EventId.makeUnsafe(crypto.randomUUID()),
                  tone: "info",
                  kind: CONNECTION_CHANGED_ACTIVITY_KIND,
                  summary: `Connection changed to ${acceptedConnectionChange.label}`,
                  payload: {
                    previousConnectionId: acceptedConnectionChange.previousConnectionId,
                    connectionId: acceptedConnectionChange.connectionId,
                  },
                  turnId: null,
                  createdAt: command.createdAt,
                },
              },
            };
      const modelChangedEvent: Omit<OrchestrationEvent, "sequence"> | null =
        acceptedConnectionChange === undefined ||
        acceptedConnectionChange.previousModelId === null ||
        acceptedConnectionChange.modelId === acceptedConnectionChange.previousModelId
          ? null
          : {
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              }),
              ...(connectionChangedEvent === null
                ? {}
                : { causationEventId: connectionChangedEvent.eventId }),
              type: "thread.activity-appended",
              payload: {
                threadId: command.threadId,
                activity: {
                  id: EventId.makeUnsafe(crypto.randomUUID()),
                  tone: "info",
                  kind: MODEL_CHANGED_ACTIVITY_KIND,
                  summary: `Model changed to ${acceptedConnectionChange.modelLabel}`,
                  payload: {
                    previousModelId: acceptedConnectionChange.previousModelId,
                    modelId: acceptedConnectionChange.modelId,
                    modelLabel: acceptedConnectionChange.modelLabel,
                  },
                  turnId: null,
                  createdAt: command.createdAt,
                },
              },
            };
      const selectionChangedEvents = [connectionChangedEvent, modelChangedEvent].filter(
        (event): event is Omit<OrchestrationEvent, "sequence"> => event !== null,
      );
      const activeProvider =
        targetThread.session?.providerName ?? targetThread.modelSelection.provider;
      const hasTurnInFlight =
        targetThread.session?.status === "starting" ||
        (targetThread.session?.status === "running" && targetThread.session.activeTurnId !== null);
      // Queue ownership is causal, not a presentation detail. A terminal event
      // can make the projected provider session look ready before the durable
      // queue head has been promoted. A normal message admitted in that window
      // must join the existing FIFO instead of briefly presenting as a direct
      // start and relying on the provider reactor to repair it later.
      const hasQueuedWork = (targetThread.queuedMessageIds?.length ?? 0) > 0;
      const shouldQueue =
        (hasTurnInFlight || hasQueuedWork) &&
        (dispatchMode === "queue" || !providerSupportsNativeTurnSteering(activeProvider));
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        ...(selectionChangedEvents.length === 0
          ? {}
          : { causationEventId: selectionChangedEvents.at(-1)!.eventId }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          ...(command.message.skills !== undefined ? { skills: command.message.skills } : {}),
          ...(command.message.mentions !== undefined ? { mentions: command.message.mentions } : {}),
          dispatchMode,
          dispatchOrigin: command.dispatchOrigin ?? "user",
          ...(command.dispatchOrigin === "agent" && command.senderThreadId !== undefined
            ? { senderThreadId: command.senderThreadId }
            : {}),
          delivery: {
            state: shouldQueue ? "queued" : dispatchMode === "steer" ? "steering" : "starting",
            queued: shouldQueue,
          },
          turnId,
          streaming: false,
          source: "native",
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnRequestPayload = {
        threadId: command.threadId,
        turnId,
        messageId: command.message.messageId,
        ...(command.modelSelection !== undefined ? { modelSelection: command.modelSelection } : {}),
        ...(command.connectionId !== undefined ? { connectionId: command.connectionId } : {}),
        ...(command.bindingRevision !== undefined
          ? { bindingRevision: command.bindingRevision }
          : {}),
        ...(command.providerOptions !== undefined
          ? { providerOptions: command.providerOptions }
          : {}),
        ...(command.reviewTarget !== undefined ? { reviewTarget: command.reviewTarget } : {}),
        assistantDeliveryMode: command.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
        dispatchMode,
        dispatchOrigin: command.dispatchOrigin ?? "user",
        ...(command.dispatchOrigin === "agent" && command.senderThreadId !== undefined
          ? { senderThreadId: command.senderThreadId }
          : {}),
        runtimeMode: command.runtimeMode,
        createdAt: command.createdAt,
      } as const;
      const queuedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: shouldQueue ? "thread.turn-queued" : "thread.turn-start-requested",
        payload: turnRequestPayload,
      };
      if (shouldQueue && dispatchMode === "steer") {
        return [
          ...selectionChangedEvents,
          userMessageEvent,
          queuedEvent,
          {
            ...withEventBase({
              aggregateKind: "thread",
              aggregateId: command.threadId,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            }),
            causationEventId: queuedEvent.eventId,
            type: "thread.turn-interrupt-requested",
            payload: {
              threadId: command.threadId,
              turnId: targetThread.session?.activeTurnId ?? undefined,
              createdAt: command.createdAt,
            },
          },
        ];
      }
      return [...selectionChangedEvents, userMessageEvent, queuedEvent];
    }

    case "thread.turn.dispatch-queued": {
      if (userStopRequested) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Queued turn admission is paused after Stop.",
          code: "queued_turn_stopped",
        });
      }
      const thread = yield* requireThreadCanTakeWork({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          messageId: command.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.connectionId !== undefined ? { connectionId: command.connectionId } : {}),
          ...(command.bindingRevision !== undefined
            ? { bindingRevision: command.bindingRevision }
            : {}),
          ...(command.providerOptions !== undefined
            ? { providerOptions: command.providerOptions }
            : {}),
          ...(command.reviewTarget !== undefined ? { reviewTarget: command.reviewTarget } : {}),
          assistantDeliveryMode: command.assistantDeliveryMode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
          dispatchMode: command.dispatchMode ?? "queue",
          dispatchOrigin: command.dispatchOrigin ?? "user",
          ...(command.dispatchOrigin === "agent" && command.senderThreadId !== undefined
            ? { senderThreadId: command.senderThreadId }
            : {}),
          runtimeMode: command.runtimeMode,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.turn.interrupt": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const interruptRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: { userStopRequested: true },
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          ...(command.pendingMessageId !== undefined
            ? { pendingMessageId: command.pendingMessageId }
            : {}),
          createdAt: command.createdAt,
        },
      };
      if (thread.session?.status !== "starting" || command.pendingMessageId === undefined) {
        return interruptRequestedEvent;
      }
      const interruptedSessionEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: {
            ...thread.session,
            status: "interrupted",
            activeTurnId: null,
            lastError: null,
            updatedAt: command.createdAt,
          },
        },
      };
      return [
        interruptedSessionEvent,
        {
          ...interruptRequestedEvent,
          causationEventId: interruptedSessionEvent.eventId,
        },
      ];
    }

    case "thread.turn.steer-queued": {
      yield* requireThreadCanTakeWork({ readModel, command, threadId: command.threadId });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-steer-queued-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.task.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.task-stop-requested",
        payload: {
          threadId: command.threadId,
          taskId: command.taskId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.task.background": {
      yield* requireThreadCanTakeWork({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.task-background-requested",
        payload: {
          threadId: command.threadId,
          toolUseId: command.toolUseId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.conversation.rollback": {
      const thread = yield* requireThreadCanTakeWork({
        readModel,
        command,
        threadId: command.threadId,
      });
      const rollbackTarget = deriveConversationRollbackTarget(thread.messages, command.messageId);
      if (!rollbackTarget || rollbackTarget.role !== "user") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Conversation rollback must target an existing user message.",
        });
      }
      if (command.numTurns <= 0 || rollbackTarget.removedTurnIds.size !== command.numTurns) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Conversation rollback requested ${command.numTurns} turn(s), but target message '${command.messageId}' would remove ${rollbackTarget.removedTurnIds.size} turn(s).`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.conversation-rollback-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          numTurns: command.numTurns,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sessionChanged =
        (command.expectedSessionStatus !== undefined &&
          thread.session?.status !== command.expectedSessionStatus) ||
        (command.expectedSessionUpdatedAt !== undefined &&
          thread.session?.updatedAt !== command.expectedSessionUpdatedAt);
      if (sessionChanged) {
        if (command.preserveCurrentSessionOnMismatch === true && thread.session !== null) {
          return {
            ...withEventBase({
              aggregateKind: "thread",
              aggregateId: command.threadId,
              occurredAt: command.createdAt,
              commandId: command.commandId,
              metadata: {},
            }),
            type: "thread.session-set",
            payload: {
              threadId: command.threadId,
              session: thread.session,
            },
          };
        }
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' session changed before the conditional update.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
    }

    case "thread.messages.import": {
      yield* requireThreadCanTakeWork({
        readModel,
        command,
        threadId: command.threadId,
      });
      return command.messages.map((message) => ({
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent" as const,
        payload: {
          threadId: command.threadId,
          messageId: message.messageId,
          role: message.role,
          text: message.text,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          turnId: null,
          streaming: false,
          source: "native" as const,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        },
      }));
    }

    case "thread.message.assistant.delta": {
      const thread = yield* (
        allowArchivedProviderProjection ? requireThread : requireThreadCanTakeWork
      )({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingMessage = thread.messages.find((message) => message.id === command.messageId);
      const expectedTextByteLength =
        command.expectedTextByteLength ?? Buffer.byteLength(existingMessage?.text ?? "", "utf8");
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: resolveStableMessageTurnId({
            existingTurnId: existingMessage?.turnId,
            incomingTurnId: command.turnId,
          }),
          streaming: true,
          expectedTextByteLength,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      const thread = yield* (
        allowArchivedProviderProjection ? requireThread : requireThreadCanTakeWork
      )({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingMessage = thread.messages.find((message) => message.id === command.messageId);
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.finalText ?? existingMessage?.text ?? "",
          turnId: resolveStableMessageTurnId({
            existingTurnId: existingMessage?.turnId,
            incomingTurnId: command.turnId,
          }),
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.conversation.rollback.complete": {
      yield* requireThreadCanTakeWork({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.conversation-rolled-back",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          numTurns: command.numTurns,
          ...(command.removedTurnIds !== undefined
            ? { removedTurnIds: command.removedTurnIds }
            : {}),
          ...(command.skipAttachmentPrune !== undefined
            ? { skipAttachmentPrune: command.skipAttachmentPrune }
            : {}),
        },
      };
    }

    case "thread.turn.start.cancel.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-start-cancelled",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          cancelledAt: command.createdAt,
        },
      };
    }

    case "thread.message.delivery.set": {
      yield* requireThreadCanTakeWork({
        readModel,
        command,
        threadId: command.threadId,
      });
      // The command read model deliberately hydrates thread shells without
      // transcript messages. Delivery acknowledgements must therefore remain
      // valid across process restart without consulting `thread.messages`.
      // If an acknowledgement raced a pre-acceptance cancellation, projection
      // treats this event as an idempotent no-op because its target row is gone.
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-delivery-set",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          state: command.state,
          ...(command.providerTurnId !== undefined
            ? { providerTurnId: command.providerTurnId }
            : {}),
          ...(command.terminalState !== undefined ? { terminalState: command.terminalState } : {}),
          ...(command.terminalCompletedAt !== undefined
            ? { terminalCompletedAt: command.terminalCompletedAt }
            : {}),
          ...(command.queued !== undefined ? { queued: command.queued } : {}),
          ...(command.failurePhase !== undefined ? { failurePhase: command.failurePhase } : {}),
          ...(command.failureDetail !== undefined ? { failureDetail: command.failureDetail } : {}),
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.activity.append": {
      yield* (allowArchivedProviderProjection ? requireThread : requireThreadCanTakeWork)({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    case "thread.activity-read-model.touch": {
      yield* (allowArchivedProviderProjection ? requireThread : requireThreadCanTakeWork)({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.activity-read-model-updated",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          ...(command.activity === undefined ? {} : { activity: command.activity }),
          updatedAt: command.createdAt,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
