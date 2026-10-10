import {
  CommandId,
  FolderId,
  SpaceId,
  ThreadDeckId,
  ThreadId,
  singletonThreadDeckId,
  type OrchestrationCommand,
} from "@penkra/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-09-16T12:00:00.000Z";
type ReadModel = ReturnType<typeof createEmptyReadModel>;

async function dispatch(readModel: ReadModel, command: OrchestrationCommand) {
  const decided = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  let next = readModel;
  for (const event of Array.isArray(decided) ? decided : [decided]) {
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 }),
    );
  }
  return next;
}

async function setup() {
  let model = createEmptyReadModel(NOW);
  for (const [spaceId, name] of [
    ["space-a", "A"],
    ["space-b", "B"],
  ] as const) {
    model = await dispatch(model, {
      type: "space.create",
      commandId: CommandId.makeUnsafe(`create-${spaceId}`),
      spaceId: SpaceId.makeUnsafe(spaceId),
      name,
      icon: "bag",
      createdAt: NOW,
    });
  }
  for (const [folderId, spaceId] of [
    ["folder-a", "space-a"],
    ["folder-b", "space-a"],
    ["folder-c", "space-b"],
  ] as const) {
    model = await dispatch(model, {
      type: "folder.create",
      commandId: CommandId.makeUnsafe(`create-${folderId}`),
      folderId: FolderId.makeUnsafe(folderId),
      spaceId: SpaceId.makeUnsafe(spaceId),
      title: folderId,
      workspaceRoot: null,
      createdAt: NOW,
    });
  }
  for (const [threadId, folderId] of [
    ["thread-a", "folder-a"],
    ["thread-b", "folder-b"],
    ["thread-c", "folder-c"],
    ["thread-d", "folder-a"],
  ] as const) {
    const id = ThreadId.makeUnsafe(threadId);
    model = await dispatch(model, {
      type: "thread.create",
      commandId: CommandId.makeUnsafe(`create-${threadId}`),
      threadId: id,
      deckId: singletonThreadDeckId(id),
      folderId: FolderId.makeUnsafe(folderId),
      title: threadId,
      modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      createdAt: NOW,
    });
  }
  return model;
}

describe("Thread Decks", () => {
  it("aborts only its own untouched empty gateway creation", async () => {
    let model = await setup();
    const child = ThreadId.makeUnsafe("gateway-child");
    model = await dispatch(model, {
      type: "thread.create",
      commandId: CommandId.makeUnsafe("create-gateway-child"),
      threadId: child,
      deckId: singletonThreadDeckId(child),
      folderId: FolderId.makeUnsafe("folder-a"),
      title: "Gateway child",
      modelSelection: { provider: "codex", model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      creationSource: "penkra_mcp",
      sourceThreadId: ThreadId.makeUnsafe("thread-a"),
      gatewayOperationId: "gateway:create:child",
      createdAt: NOW,
    });
    const abort = {
      type: "thread.delete",
      commandId: CommandId.makeUnsafe("abort-gateway-child"),
      threadId: child,
      expectedEmptyGatewayOperationId: "gateway:create:child",
    } as const;
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: model,
          command: { ...abort, expectedEmptyGatewayOperationId: "gateway:create:other" },
        }),
      ),
    ).rejects.toThrow("no longer an empty gateway creation");
    const pinned = {
      ...model,
      threads: model.threads.map((thread) =>
        thread.id === child ? { ...thread, isPinned: true } : thread,
      ),
    };
    await expect(
      Effect.runPromise(decideOrchestrationCommand({ readModel: pinned, command: abort })),
    ).rejects.toThrow("no longer an empty gateway creation");
    const renamed = await dispatch(model, {
      type: "thread.update",
      commandId: CommandId.makeUnsafe("rename-gateway-child"),
      threadId: child,
      title: "Renamed child",
    });
    await expect(
      Effect.runPromise(decideOrchestrationCommand({ readModel: renamed, command: abort })),
    ).rejects.toThrow("no longer an empty gateway creation");
    model = await dispatch(model, abort);
    expect(model.threads.find((thread) => thread.id === child)?.deletedAt).not.toBeNull();
  });
});
