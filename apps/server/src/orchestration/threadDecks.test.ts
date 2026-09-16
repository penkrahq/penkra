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
  it("moves, reorders, and leaves without changing sidebar ownership", async () => {
    let model = await setup();
    const threadA = ThreadId.makeUnsafe("thread-a");
    const threadB = ThreadId.makeUnsafe("thread-b");
    const deckA = singletonThreadDeckId(threadA);
    const deckB = singletonThreadDeckId(threadB);

    model = await dispatch(model, {
      type: "thread.deck.move",
      commandId: CommandId.makeUnsafe("add-b-to-a"),
      threadId: threadB,
      deckId: deckA,
      position: { type: "end" },
    });
    expect(model.decks.find((deck) => deck.id === deckA)?.threadIds).toEqual([threadA, threadB]);
    expect(model.decks.some((deck) => deck.id === deckB)).toBe(false);
    expect(model.threads.find((thread) => thread.id === threadB)?.folderId).toBe(
      FolderId.makeUnsafe("folder-b"),
    );

    model = await dispatch(model, {
      type: "thread.deck.move",
      commandId: CommandId.makeUnsafe("reorder-b-before-a"),
      threadId: threadB,
      deckId: deckA,
      position: { type: "before", threadId: threadA },
    });
    expect(model.decks.find((deck) => deck.id === deckA)?.threadIds).toEqual([threadB, threadA]);

    model = await dispatch(model, {
      type: "thread.deck.leave",
      commandId: CommandId.makeUnsafe("leave-b"),
      threadId: threadB,
      deckId: deckB,
    });
    expect(model.decks.find((deck) => deck.id === deckA)?.threadIds).toEqual([threadA]);
    expect(model.decks.find((deck) => deck.id === deckB)?.threadIds).toEqual([threadB]);
  });

  it("rejects cross-Space decks and cross-Space sidebar moves for grouped Threads", async () => {
    let model = await setup();
    const threadA = ThreadId.makeUnsafe("thread-a");
    const threadB = ThreadId.makeUnsafe("thread-b");
    const threadC = ThreadId.makeUnsafe("thread-c");
    const deckA = singletonThreadDeckId(threadA);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: model,
          command: {
            type: "thread.deck.move",
            commandId: CommandId.makeUnsafe("cross-space-deck"),
            threadId: threadC,
            deckId: deckA,
            position: { type: "end" },
          },
        }),
      ),
    ).rejects.toThrow("different Spaces");

    model = await dispatch(model, {
      type: "thread.deck.move",
      commandId: CommandId.makeUnsafe("group-b"),
      threadId: threadB,
      deckId: deckA,
      position: { type: "end" },
    });
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: model,
          command: {
            type: "sidebar.item.move",
            commandId: CommandId.makeUnsafe("move-group-member-across-space"),
            item: { kind: "thread", id: threadB },
            target: {
              kind: "folder",
              folderId: FolderId.makeUnsafe("folder-c"),
            },
            position: { type: "pinned-boundary" },
          },
        }),
      ),
    ).rejects.toThrow("multi-thread deck");
  });

  it("rejects leaving a singleton deck", async () => {
    const model = await setup();
    const threadA = ThreadId.makeUnsafe("thread-a");
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel: model,
          command: {
            type: "thread.deck.leave",
            commandId: CommandId.makeUnsafe("leave-singleton"),
            threadId: threadA,
            deckId: ThreadDeckId.makeUnsafe("deck:new"),
          },
        }),
      ),
    ).rejects.toThrow("more than one Thread");
  });

  it("preserves archived membership, removes deleted members, and deletes an empty deck", async () => {
    let model = await setup();
    const threadA = ThreadId.makeUnsafe("thread-a");
    const threadB = ThreadId.makeUnsafe("thread-b");
    const deckA = singletonThreadDeckId(threadA);

    model = await dispatch(model, {
      type: "thread.deck.move",
      commandId: CommandId.makeUnsafe("group-for-lifecycle"),
      threadId: threadB,
      deckId: deckA,
      position: { type: "end" },
    });
    model = await dispatch(model, {
      type: "thread.archive",
      commandId: CommandId.makeUnsafe("archive-b"),
      threadId: threadB,
    });
    expect(model.decks.find((deck) => deck.id === deckA)?.threadIds).toEqual([threadA, threadB]);

    model = await dispatch(model, {
      type: "thread.unarchive",
      commandId: CommandId.makeUnsafe("restore-b"),
      threadId: threadB,
    });
    model = await dispatch(model, {
      type: "thread.delete",
      commandId: CommandId.makeUnsafe("delete-a"),
      threadId: threadA,
    });
    expect(model.decks.find((deck) => deck.id === deckA)?.threadIds).toEqual([threadB]);

    model = await dispatch(model, {
      type: "thread.delete",
      commandId: CommandId.makeUnsafe("delete-b"),
      threadId: threadB,
    });
    expect(model.decks.some((deck) => deck.id === deckA)).toBe(false);
  });

  it("converges independent window projections on the serialized deck event stream", async () => {
    let authoritative = await setup();
    let firstWindow = authoritative;
    let secondWindow = authoritative;
    const deckA = singletonThreadDeckId(ThreadId.makeUnsafe("thread-a"));

    for (const [threadId, commandId] of [
      ["thread-b", "window-one-add-b"],
      ["thread-d", "window-two-add-d"],
    ] as const) {
      const decided = await Effect.runPromise(
        decideOrchestrationCommand({
          readModel: authoritative,
          command: {
            type: "thread.deck.move",
            commandId: CommandId.makeUnsafe(commandId),
            threadId: ThreadId.makeUnsafe(threadId),
            deckId: deckA,
            position: { type: "end" },
          },
        }),
      );
      for (const event of Array.isArray(decided) ? decided : [decided]) {
        const sequenced = {
          ...event,
          sequence: authoritative.snapshotSequence + 1,
        };
        authoritative = await Effect.runPromise(projectEvent(authoritative, sequenced));
        firstWindow = await Effect.runPromise(projectEvent(firstWindow, sequenced));
        secondWindow = await Effect.runPromise(projectEvent(secondWindow, sequenced));
      }
    }

    expect(firstWindow).toEqual(authoritative);
    expect(secondWindow).toEqual(authoritative);
    expect(authoritative.decks.find((deck) => deck.id === deckA)?.threadIds).toEqual([
      ThreadId.makeUnsafe("thread-a"),
      ThreadId.makeUnsafe("thread-b"),
      ThreadId.makeUnsafe("thread-d"),
    ]);
  });
});
