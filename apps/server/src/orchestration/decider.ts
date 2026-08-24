import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
} from "@penkra/contracts";
import {
  EventId,
  MAX_PINNED_PROJECTS,
  PINNED_MESSAGES_MAX_COUNT,
  SPACES_MAX_COUNT,
  TurnId,
} from "@penkra/contracts";
import {
  collectTailTurnIds,
  resolveTailUserMessageEditTarget,
} from "@penkra/shared/conversationEdit";
import { Effect } from "effect";
import { normalizeEntityName } from "@penkra/shared/entityNames";
import { providerSupportsNativeTurnSteering } from "@penkra/shared/providerMetadata";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { resolveStableMessageTurnId } from "./messageTurnId.ts";
import {
  findSpaceById,
  listActiveSpaces,
  listThreadsByFolderId,
  requireFolder,
  requireFolderAbsent,
  requireFolderHasNoThreads,
  requireFolderNameAvailable,
  requireSpace,
  requireSpaceAbsent,
  requireSpaceNameAvailable,
  requireThread,
  requireThreadAbsent,
  requireThreadArchived,
  requireThreadNotArchived,
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

function omitNullUserInputAnswers(
  command: Extract<OrchestrationCommand, { type: "thread.user-input.respond" }>,
) {
  return Object.fromEntries(
    Object.entries(command.answers).filter(([, answer]) => answer !== null && answer !== undefined),
  );
}

function countPinnedFolders(
  readModel: OrchestrationReadModel,
  options?: { readonly excludeFolderIds?: ReadonlySet<string> },
): number {
  return readModel.folders.filter(
    (folder) =>
      folder.deletedAt === null &&
      folder.isPinned === true &&
      !options?.excludeFolderIds?.has(folder.id),
  ).length;
}

function validateProjectPinLimit(input: {
  readonly command: Extract<OrchestrationCommand, { type: "folder.create" | "folder.update" }>;
  readonly readModel: OrchestrationReadModel;
  readonly folderId: OrchestrationEvent["aggregateId"];
  readonly nextDeletedAt?: string | null;
  readonly wasPinned?: boolean;
  readonly staleFolderIds?: ReadonlySet<string>;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.command.isPinned !== true) {
    return Effect.void;
  }

  if (input.nextDeletedAt !== undefined && input.nextDeletedAt !== null) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Deleted folder '${input.folderId}' cannot be pinned.`,
      }),
    );
  }

  if (input.wasPinned === true) {
    return Effect.void;
  }

  const excludeFolderIds = new Set<string>([input.folderId, ...(input.staleFolderIds ?? [])]);
  const pinnedProjectCount = countPinnedFolders(input.readModel, { excludeFolderIds });
  if (pinnedProjectCount < MAX_PINNED_PROJECTS) {
    return Effect.void;
  }

  return Effect.fail(
    new OrchestrationCommandInvariantError({
      commandType: input.command.type,
      detail: `Only ${MAX_PINNED_PROJECTS} folders can be pinned at once.`,
    }),
  );
}

function isLiveSidebarThread(thread: OrchestrationThread): boolean {
  return thread.deletedAt === null && thread.archivedAt == null;
}

function collectThreadTreeIds(
  readModel: OrchestrationReadModel,
  rootThreadId: OrchestrationThread["id"],
): Set<OrchestrationThread["id"]> {
  const ids = new Set<OrchestrationThread["id"]>([rootThreadId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const thread of readModel.threads) {
      if (thread.deletedAt !== null || !thread.parentThreadId || ids.has(thread.id)) continue;
      if (ids.has(thread.parentThreadId)) {
        ids.add(thread.id);
        changed = true;
      }
    }
  }
  return ids;
}

type CreatedThreadWorkspaceCommand = Pick<
  Extract<OrchestrationCommand, { type: "thread.create" | "thread.fork.create" }>,
  "workingDirectory"
>;

function resolveCreatedThreadWorkspaceMetadata(command: CreatedThreadWorkspaceCommand) {
  return { workingDirectory: command.workingDirectory ?? null };
}

function resolveThreadWorkspaceMetadataPatch(
  command: Extract<OrchestrationCommand, { type: "thread.update" }>,
) {
  return {
    ...(command.workingDirectory !== undefined
      ? { workingDirectory: command.workingDirectory }
      : {}),
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
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly workspacePaths?:
    | { readonly homeDir: string; readonly chatWorkspaceRoot: string }
    | undefined;
  readonly acceptedConnectionChange?: AcceptedConnectionChange | undefined;
}): Effect.fn.Return<
  Omit<OrchestrationEvent, "sequence"> | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  OrchestrationCommandInvariantError
> {
  switch (command.type) {
    case "space.create": {
      yield* requireSpaceAbsent({ readModel, command, spaceId: command.spaceId });
      yield* requireSpaceNameAvailable({ readModel, command, name: command.name });
      const activeSpaces = listActiveSpaces(readModel);
      if (activeSpaces.length >= SPACES_MAX_COUNT) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `A maximum of ${SPACES_MAX_COUNT} custom spaces is supported.`,
        });
      }
      const sortOrder = activeSpaces.reduce(
        (maximum, space) => Math.max(maximum, space.sortOrder + 1),
        0,
      );
      return {
        ...withEventBase({
          aggregateKind: "space",
          aggregateId: command.spaceId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "space.created",
        payload: {
          spaceId: command.spaceId,
          name: command.name,
          icon: command.icon,
          sortOrder,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "space.update": {
      const existingSpace = yield* requireSpace({ readModel, command, spaceId: command.spaceId });
      // Fields equal to the current value are not changes: a Save with nothing edited (or a
      // rename that resends the icon) must not append an event or bump updatedAt.
      const nextName =
        command.name !== undefined && command.name !== existingSpace.name
          ? command.name
          : undefined;
      const nextIcon =
        command.icon !== undefined && command.icon !== existingSpace.icon
          ? command.icon
          : undefined;
      const activeSpaces = listActiveSpaces(readModel);
      const currentIndex = activeSpaces.findIndex((space) => space.id === command.spaceId);
      const targetIndex =
        command.sortOrder === undefined
          ? currentIndex
          : Math.min(command.sortOrder, Math.max(activeSpaces.length - 1, 0));
      const orderedSpaceIds = activeSpaces.map((space) => space.id);
      if (targetIndex !== currentIndex) {
        orderedSpaceIds.splice(currentIndex, 1);
        orderedSpaceIds.splice(targetIndex, 0, command.spaceId);
      }
      if (nextName === undefined && nextIcon === undefined && targetIndex === currentIndex) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Space update must change a name, icon, or sort order.",
        });
      }
      if (nextName !== undefined) {
        yield* requireSpaceNameAvailable({
          readModel,
          command,
          name: nextName,
          excludeSpaceId: command.spaceId,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "space",
          aggregateId: command.spaceId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "space.updated",
        payload: {
          spaceId: command.spaceId,
          ...(nextName !== undefined ? { name: nextName } : {}),
          ...(nextIcon !== undefined ? { icon: nextIcon } : {}),
          ...(targetIndex !== currentIndex ? { orderedSpaceIds } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "space.archive": {
      yield* requireSpace({ readModel, command, spaceId: command.spaceId });
      if (listActiveSpaces(readModel).length <= 1) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "At least one active Space must remain.",
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "space",
          aggregateId: command.spaceId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "space.archived",
        payload: { spaceId: command.spaceId, archivedAt: occurredAt },
      };
    }

    case "space.restore": {
      const existingSpace = findSpaceById(readModel, command.spaceId);
      if (!existingSpace || existingSpace.deletedAt !== null || existingSpace.archivedAt === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Space '${command.spaceId}' is not available to restore.`,
        });
      }
      if (listActiveSpaces(readModel).length >= SPACES_MAX_COUNT) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `A maximum of ${SPACES_MAX_COUNT} active custom spaces is supported.`,
        });
      }
      const restoredName = command.name ?? existingSpace.name;
      yield* requireSpaceNameAvailable({
        readModel,
        command,
        name: restoredName,
        excludeSpaceId: existingSpace.id,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "space",
          aggregateId: command.spaceId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "space.restored",
        payload: {
          spaceId: command.spaceId,
          ...(restoredName !== existingSpace.name ? { name: restoredName } : {}),
          restoredAt: occurredAt,
        },
      };
    }

    case "space.delete": {
      const existingSpace = findSpaceById(readModel, command.spaceId);
      if (!existingSpace || existingSpace.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Space '${command.spaceId}' does not exist or was already deleted.`,
        });
      }
      if (existingSpace.archivedAt === null && listActiveSpaces(readModel).length <= 1) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "At least one active Space must remain.",
        });
      }
      if (
        readModel.folders.some(
          (folder) => folder.deletedAt === null && folder.spaceId === command.spaceId,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Move every folder out of this Space before deleting it.",
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "space",
          aggregateId: command.spaceId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "space.deleted",
        payload: { spaceId: command.spaceId, deletedAt: occurredAt },
      };
    }

    case "folder.move": {
      yield* requireSpace({ readModel, command, spaceId: command.spaceId });
      const occurredAt = nowIso();
      const seenFolderIds = new Set<string>();
      const destinationFolderNames = new Set(
        readModel.folders
          .filter((folder) => folder.deletedAt === null && folder.spaceId === command.spaceId)
          .map((folder) => normalizeEntityName(folder.title)),
      );
      const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
      for (const folderId of command.folderIds) {
        if (seenFolderIds.has(folderId)) continue;
        seenFolderIds.add(folderId);
        const folder = yield* requireFolder({ readModel, command, folderId });
        // Already-filed and concurrently-deleted folders are settled, not errors: the
        // batch stays atomic for real failures without rejecting a raced retry.
        if (folder.deletedAt !== null || folder.spaceId === command.spaceId) continue;
        const normalizedFolderName = normalizeEntityName(folder.title);
        if (destinationFolderNames.has(normalizedFolderName)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `A folder named '${folder.title}' already exists in this Space.`,
          });
        }
        destinationFolderNames.add(normalizedFolderName);
        events.push({
          ...withEventBase({
            aggregateKind: "folder",
            aggregateId: folder.id,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "folder.moved" as const,
          payload: {
            folderId: folder.id,
            spaceId: command.spaceId,
            updatedAt: occurredAt,
          },
        });
      }
      if (events.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "None of the selected folders need to be assigned to this space.",
        });
      }
      return events;
    }

    case "sidebar.item.move": {
      const targetProject =
        command.target.kind === "folder"
          ? yield* requireFolder({
              readModel,
              command,
              folderId: command.target.folderId,
            })
          : null;
      const targetSpace =
        command.target.kind === "space"
          ? yield* requireSpace({ readModel, command, spaceId: command.target.spaceId })
          : yield* requireSpace({
              readModel,
              command,
              spaceId: targetProject!.spaceId,
            });

      const movedProject =
        command.item.kind === "folder"
          ? yield* requireFolder({ readModel, command, folderId: command.item.id })
          : null;
      const movedThread =
        command.item.kind === "thread"
          ? yield* requireThread({ readModel, command, threadId: command.item.id })
          : null;
      if (movedProject && command.target.kind !== "space") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Folders cannot be nested inside other folders.",
        });
      }
      if (movedProject && movedProject.spaceId !== targetSpace.id) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "Move the folder with 'folder.move' before reordering it in the destination Space.",
        });
      }
      if (movedProject) {
        yield* requireFolderNameAvailable({
          readModel,
          command,
          name: movedProject.title,
          spaceId: targetSpace.id,
          excludeFolderId: movedProject.id,
        });
      }
      if (movedThread && movedThread.parentThreadId !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Nested child threads move together with their root thread.",
        });
      }
      if (movedThread && command.target.kind === "space") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Threads must be moved into a folder, not directly into a Space.",
        });
      }
      if (movedThread && !isLiveSidebarThread(movedThread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Archived or deleted threads cannot be moved in the sidebar.",
        });
      }

      const destinationItems = (
        command.target.kind === "space"
          ? [
              ...readModel.folders
                .filter(
                  (folder) =>
                    folder.deletedAt === null &&
                    folder.spaceId === targetSpace.id &&
                    folder.id !== movedProject?.id,
                )
                .map((folder) => ({
                  item: { kind: "folder" as const, id: folder.id },
                  pinned: folder.isPinned === true,
                  sidebarSortOrder: folder.sidebarSortOrder ?? 0,
                  createdAt: folder.createdAt,
                })),
            ]
          : readModel.threads
              .filter(
                (thread) =>
                  isLiveSidebarThread(thread) &&
                  thread.parentThreadId === null &&
                  thread.folderId === targetProject!.id &&
                  thread.id !== movedThread?.id,
              )
              .map((thread) => ({
                item: { kind: "thread" as const, id: thread.id },
                pinned: thread.isPinned === true,
                sidebarSortOrder: thread.sidebarSortOrder ?? 0,
                createdAt: thread.createdAt,
              }))
      ).toSorted((left, right) => {
        const byPinned = Number(right.pinned) - Number(left.pinned);
        if (byPinned !== 0) return byPinned;
        const byManualOrder = left.sidebarSortOrder - right.sidebarSortOrder;
        if (byManualOrder !== 0) return byManualOrder;
        const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
        if (byCreatedAt !== 0) return byCreatedAt;
        return left.item.id.localeCompare(right.item.id);
      });
      const movedItemPinned = (movedProject ?? movedThread)?.isPinned === true;
      const orderedItems = destinationItems.map(({ item }) => item);
      let insertionIndex = destinationItems.filter(({ pinned }) => pinned).length;
      if (command.position.type !== "pinned-boundary") {
        const anchorItem = command.position.item;
        const anchorIndex = destinationItems.findIndex(
          ({ item }) => item.kind === anchorItem.kind && item.id === anchorItem.id,
        );
        if (anchorIndex < 0) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "The drop anchor is no longer in the destination.",
          });
        }
        if (destinationItems[anchorIndex]!.pinned !== movedItemPinned) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Pinned and unpinned items cannot be interleaved.",
          });
        }
        insertionIndex = anchorIndex + (command.position.type === "after" ? 1 : 0);
      }
      orderedItems.splice(insertionIndex, 0, command.item);

      const folderUpdates = new Map<
        string,
        {
          folderId: OrchestrationReadModel["folders"][number]["id"];
          sidebarSortOrder?: number;
        }
      >();
      const threadUpdates = new Map<
        string,
        {
          threadId: OrchestrationThread["id"];
          folderId?: OrchestrationReadModel["folders"][number]["id"];
          sidebarSortOrder?: number;
        }
      >();
      orderedItems.forEach((item, sidebarSortOrder) => {
        if (item.kind === "folder") {
          folderUpdates.set(item.id, { folderId: item.id, sidebarSortOrder });
        } else {
          threadUpdates.set(item.id, { threadId: item.id, sidebarSortOrder });
        }
      });

      if (movedThread) {
        const destinationProject = targetProject!;
        const treeIds = collectThreadTreeIds(readModel, movedThread.id);
        for (const threadId of treeIds) {
          threadUpdates.set(threadId, {
            ...threadUpdates.get(threadId),
            threadId,
            folderId: destinationProject.id,
          });
        }
      }

      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "space",
          aggregateId: targetSpace.id,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "sidebar.layout-updated",
        payload: {
          folderUpdates: [...folderUpdates.values()],
          threadUpdates: [...threadUpdates.values()],
          updatedAt: occurredAt,
        },
      };
    }

    case "folder.create": {
      yield* requireFolderAbsent({
        readModel,
        command,
        folderId: command.folderId,
      });
      if (command.workspaceRoot !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "Folders are virtual containers. Set the physical directory on the thread instead.",
        });
      }
      yield* validateProjectPinLimit({
        command,
        readModel,
        folderId: command.folderId,
      });
      yield* requireSpace({ readModel, command, spaceId: command.spaceId });
      yield* requireFolderNameAvailable({
        readModel,
        command,
        name: command.title,
        spaceId: command.spaceId,
      });
      return {
        ...withEventBase({
          aggregateKind: "folder",
          aggregateId: command.folderId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "folder.created",
        payload: {
          folderId: command.folderId,
          title: command.title,
          workspaceRoot: null,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          iconDataUrl: null,
          isPinned: command.isPinned,
          spaceId: command.spaceId,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "folder.update": {
      const existingProject = yield* requireFolder({
        readModel,
        command,
        folderId: command.folderId,
      });
      if (command.archivedAt !== undefined && existingProject.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Deleted folders cannot be archived or restored.",
        });
      }
      if (command.title !== undefined) {
        yield* requireFolderNameAvailable({
          readModel,
          command,
          name: command.title ?? existingProject.title,
          spaceId: existingProject.spaceId,
          excludeFolderId: command.folderId,
        });
      }
      yield* validateProjectPinLimit({
        command,
        readModel,
        folderId: command.folderId,
        nextDeletedAt: existingProject.deletedAt,
        wasPinned: existingProject.isPinned === true,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "folder",
          aggregateId: command.folderId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "folder.updated",
        payload: {
          folderId: command.folderId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          ...(command.iconDataUrl !== undefined ? { iconDataUrl: command.iconDataUrl } : {}),
          ...(command.isPinned !== undefined ? { isPinned: command.isPinned } : {}),
          ...(command.isPinned !== undefined && command.isPinned !== existingProject.isPinned
            ? { sidebarSortOrder: 0 }
            : {}),
          ...(command.archivedAt !== undefined ? { archivedAt: command.archivedAt } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "folder.delete": {
      yield* requireFolder({
        readModel,
        command,
        folderId: command.folderId,
      });
      yield* requireFolderHasNoThreads({
        readModel,
        command,
        folderId: command.folderId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "folder",
          aggregateId: command.folderId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "folder.deleted",
        payload: {
          folderId: command.folderId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireFolder({
        readModel,
        command,
        folderId: command.folderId,
      });
      yield* requireThreadAbsent({
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
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          folderId: command.folderId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          ...resolveCreatedThreadWorkspaceMetadata(command),
          isPinned: command.isPinned,
          parentThreadId: command.parentThreadId,
          ...(command.creationSource !== undefined
            ? {
                creationSource: command.creationSource,
                sourceThreadId: command.sourceThreadId ?? null,
                sourceTurnId: command.sourceTurnId ?? null,
                gatewayOperationId: command.gatewayOperationId ?? null,
                gatewayOperationIndex: command.gatewayOperationIndex ?? null,
              }
            : {}),
          subagentAgentId: command.subagentAgentId,
          subagentNickname: command.subagentNickname,
          subagentRole: command.subagentRole,
          forkSourceThreadId: null,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.fork.create": {
      yield* requireFolder({
        readModel,
        command,
        folderId: command.folderId,
      });
      yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });

      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      if (sourceThread.folderId !== command.folderId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Source thread '${command.sourceThreadId}' belongs to a different folder.`,
        });
      }

      const createdEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          folderId: command.folderId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          ...resolveCreatedThreadWorkspaceMetadata(command),
          isPinned: false,
          parentThreadId: null,
          subagentAgentId: null,
          subagentNickname: null,
          subagentRole: null,
          forkSourceThreadId: command.sourceThreadId,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };

      // Imported messages keep their source-thread timestamps so the transcript still
      // reads chronologically. They are not activity in this thread: the retention
      // clock floors on the new thread's own createdAt/updatedAt (see
      // `threadRetention.getThreadLastActivityMs`) so a fork of an old conversation
      // is never born past the retention cutoff.
      const importedMessageEvents: ReadonlyArray<Omit<OrchestrationEvent, "sequence">> =
        command.importedMessages.map((message) => ({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: message.messageId,
            role: message.role,
            text: message.text,
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            turnId: null,
            streaming: false,
            source: "fork-import",
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          },
        }));

      return [createdEvent, ...importedMessageEvents];
    }

    case "thread.delete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        command.workingDirectory !== undefined &&
        command.workingDirectory !== thread.workingDirectory &&
        thread.messages.length > 0
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A thread's physical folder cannot change after the thread has started.",
        });
      }
      const occurredAt = nowIso();
      const visitAcknowledgementOnly = Object.keys(command).every((key) =>
        ["type", "commandId", "threadId", "lastVisitedAt"].includes(key),
      );
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...resolveThreadWorkspaceMetadataPatch(command),
          ...(command.isPinned !== undefined ? { isPinned: command.isPinned } : {}),
          ...(command.isPinned !== undefined && command.isPinned !== thread.isPinned
            ? { sidebarSortOrder: 0 }
            : {}),
          ...(command.parentThreadId !== undefined
            ? { parentThreadId: command.parentThreadId }
            : {}),
          ...(command.subagentAgentId !== undefined
            ? { subagentAgentId: command.subagentAgentId }
            : {}),
          ...(command.subagentNickname !== undefined
            ? { subagentNickname: command.subagentNickname }
            : {}),
          ...(command.subagentRole !== undefined ? { subagentRole: command.subagentRole } : {}),
          ...(command.pinnedMessages !== undefined
            ? { pinnedMessages: command.pinnedMessages }
            : {}),
          ...(command.notes !== undefined ? { notes: command.notes } : {}),
          ...(command.lastVisitedAt !== undefined ? { lastVisitedAt: command.lastVisitedAt } : {}),
          updatedAt: visitAcknowledgementOnly ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pinned-message.add": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const existingPin = thread.pinnedMessages?.find((pin) => pin.messageId === command.messageId);
      if (!existingPin && (thread.pinnedMessages?.length ?? 0) >= PINNED_MESSAGES_MAX_COUNT) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' already has the maximum of ${PINNED_MESSAGES_MAX_COUNT} pinned messages.`,
        });
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-added",
        payload: {
          threadId: command.threadId,
          pin: existingPin ?? {
            messageId: command.messageId,
            label: null,
            done: false,
            pinnedAt: occurredAt,
          },
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pinned-message.remove": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-removed",
        payload: {
          threadId: command.threadId,
          turnId: TurnId.makeUnsafe(`turn:${command.commandId}`),
          messageId: command.messageId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pinned-message.done.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-done-set",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          done: command.done,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.pinned-message.label.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.pinned-message-label-set",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          label: command.label,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.recover": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
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
          ...(command.interruptedTurnId !== undefined
            ? { recoveryOfTurnId: command.interruptedTurnId }
            : {}),
          restartRecovery: true,
          connectionId: command.connectionId,
          bindingRevision: command.bindingRevision,
          assistantDeliveryMode: DEFAULT_ASSISTANT_DELIVERY_MODE,
          dispatchMode: "queue",
          dispatchOrigin: "automation",
          runtimeMode: thread.runtimeMode,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const dispatchMode = command.dispatchMode ?? "queue";
      const turnId = command.turnId ?? TurnId.makeUnsafe(`turn:${command.commandId}`);
      const modelSelectionChangedEvent: Omit<OrchestrationEvent, "sequence"> | null =
        acceptedConnectionChange === undefined ||
        acceptedConnectionChange.previousModelId === null ||
        acceptedConnectionChange.modelId === acceptedConnectionChange.previousModelId ||
        command.modelSelection === undefined
          ? null
          : {
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              }),
              type: "thread.updated",
              payload: {
                threadId: command.threadId,
                modelSelection: command.modelSelection,
                updatedAt: command.createdAt,
              },
            };
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
              ...(modelSelectionChangedEvent === null
                ? {}
                : { causationEventId: modelSelectionChangedEvent.eventId }),
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
                ? modelSelectionChangedEvent === null
                  ? {}
                  : { causationEventId: modelSelectionChangedEvent.eventId }
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
      const selectionChangedEvents = [
        modelSelectionChangedEvent,
        connectionChangedEvent,
        modelChangedEvent,
      ].filter((event): event is Omit<OrchestrationEvent, "sequence"> => event !== null);
      const activeProvider =
        targetThread.session?.providerName ?? targetThread.modelSelection.provider;
      const hasTurnInFlight =
        targetThread.session?.status === "starting" ||
        (targetThread.session?.status === "running" && targetThread.session.activeTurnId !== null);
      // Subagent threads never queue: their messages steer the running child task
      // through the parent session, so deferring until the turn settles would
      // deliver the message only after the subagent already finished.
      const shouldQueue =
        targetThread.parentThreadId === null &&
        hasTurnInFlight &&
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
          // Explicit "user" (not absent): edit-resends replay through a fresh
          // server-side turn.start without an origin, and the projection
          // upsert coalesces absent origins — a human resend of a message
          // originally dispatched by a non-user source must overwrite the
          // stale origin instead of inheriting it.
          dispatchOrigin: command.dispatchOrigin ?? "user",
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
      const thread = yield* requireThread({
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
        { ...interruptRequestedEvent, causationEventId: interruptedSessionEvent.eventId },
      ];
    }

    case "thread.turn.cancel-queued":
    case "thread.turn.steer-queued": {
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
        type:
          command.type === "thread.turn.cancel-queued"
            ? "thread.turn-cancel-queued-requested"
            : "thread.turn-steer-queued-requested",
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
        type: "thread.task-background-requested",
        payload: {
          threadId: command.threadId,
          toolUseId: command.toolUseId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
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
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          ...(command.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: command.lifecycleGeneration }
            : {}),
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const answers = omitNullUserInputAnswers(command);
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          ...(command.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: command.lifecycleGeneration }
            : {}),
          answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.conversation.rollback": {
      const thread = yield* requireThread({
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

    case "thread.message.edit-and-resend": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const editTarget = resolveTailUserMessageEditTarget({
        messages: thread.messages,
        messageId: command.messageId,
        activeTurnId:
          thread.session?.status === "running" ? (thread.session.activeTurnId ?? null) : null,
      });
      if (!editTarget.editable) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Only the latest rollbackable user message can be edited and resent (${editTarget.reason}).`,
        });
      }
      const requestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-edit-resend-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          text: command.text,
          rollbackTurnCount: editTarget.rollbackTurnCount,
          removedTurnIds: editTarget.removedTurnIds.map((turnId) => TurnId.makeUnsafe(turnId)),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          connectionId: command.connectionId,
          bindingRevision: command.bindingRevision,
          ...(command.providerOptions !== undefined
            ? { providerOptions: command.providerOptions }
            : {}),
          ...(command.assistantDeliveryMode !== undefined
            ? { assistantDeliveryMode: command.assistantDeliveryMode }
            : {}),
          runtimeMode: command.runtimeMode,
          createdAt: command.createdAt,
        },
      };
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return requestedEvent;
      }
      const startingSessionEvent: Omit<OrchestrationEvent, "sequence"> = {
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
            threadId: command.threadId,
            status: "starting",
            providerName: thread.session?.providerName ?? thread.modelSelection.provider,
            runtimeMode: command.runtimeMode,
            activeTurnId: null,
            lastError: null,
            updatedAt: command.createdAt,
          },
        },
      };
      return [
        startingSessionEvent,
        { ...requestedEvent, causationEventId: startingSessionEvent.eventId },
      ];
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
      yield* requireThread({
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
      const thread = yield* requireThread({
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
      const thread = yield* requireThread({
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
          cancelledAt: command.createdAt,
        },
      };
    }

    case "thread.message.delivery.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const message = thread.messages.find((entry) => entry.id === command.messageId);
      if (!message || message.role !== "user") {
        // A provider acknowledgement can race an explicit pre-acceptance
        // cancellation. The cancelled message is already gone; settling the
        // late acknowledgement as an idempotent no-op keeps replay safe.
        return [];
      }
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
          state: command.state,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.activity.append": {
      yield* requireThread({
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
        type: "thread.activity-read-model-updated",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
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
