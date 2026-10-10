import { seedThreadReadModelFixture } from "../cleanCore/threadFixtures.ts";
// FILE: spaces.test.ts
// Purpose: Covers the clean persisted-Space lifecycle and folder assignment invariants.

import {
  CommandId,
  EventId,
  FolderId,
  SpaceId,
  ThreadId,
  singletonThreadDeckId,
  type OrchestrationCommand,
} from "@penkra/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

type ReadModel = ReturnType<typeof createEmptyReadModel>;
const CREATED_AT = "2026-08-02T10:00:00.000Z";

async function dispatch(readModel: ReadModel, command: OrchestrationCommand) {
  const decided = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  const eventBases = Array.isArray(decided) ? decided : [decided];
  let next = readModel;
  for (const eventBase of eventBases) {
    next = await Effect.runPromise(
      projectEvent(next, { ...eventBase, sequence: next.snapshotSequence + 1 }),
    );
  }
  return { events: eventBases, readModel: next };
}

async function addSpace(readModel: ReadModel, id: string, name: string) {
  return dispatch(readModel, {
    type: "space.create",
    commandId: CommandId.makeUnsafe(`create-${id}`),
    spaceId: SpaceId.makeUnsafe(id),
    name,
    icon: "bag",
    createdAt: CREATED_AT,
  });
}

async function addFolder(readModel: ReadModel, id: string, spaceId: SpaceId) {
  return dispatch(readModel, {
    type: "folder.create",
    commandId: CommandId.makeUnsafe(`create-${id}`),
    folderId: FolderId.makeUnsafe(id),
    title: id,
    workspaceRoot: null,
    spaceId,
    createdAt: CREATED_AT,
  });
}

async function addNamedFolder(readModel: ReadModel, id: string, title: string, spaceId: SpaceId) {
  return dispatch(readModel, {
    type: "folder.create",
    commandId: CommandId.makeUnsafe(`create-${id}`),
    folderId: FolderId.makeUnsafe(id),
    title,
    workspaceRoot: null,
    spaceId,
    createdAt: CREATED_AT,
  });
}

async function addThread(input: {
  readModel: ReadModel;
  id: string;
  folderId: FolderId;
  parentThreadId?: ThreadId;
}) {
  const event = {
    sequence: input.readModel.snapshotSequence + 1,
    eventId: EventId.makeUnsafe(`fixture-${input.id}`),
    aggregateKind: "thread" as const,
    aggregateId: ThreadId.makeUnsafe(input.id),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    occurredAt: CREATED_AT,
    metadata: {},
    payload: {
      threadId: ThreadId.makeUnsafe(input.id),
      deckId: singletonThreadDeckId(ThreadId.makeUnsafe(input.id)),
      deckSortOrder: 0,
      sidebarSortOrder: 0,
      folderId: input.folderId,
      title: input.id,
      modelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
      runtimeMode: "full-access" as const,
      workingDirectory: null,
      isPinned: false,
      parentThreadId: input.parentThreadId === undefined ? null : input.parentThreadId,
      subagentAgentId: null,
      subagentNickname: null,
      subagentRole: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  };
  return {
    events: [],
    readModel: await Effect.runPromise(
      seedThreadReadModelFixture(input.readModel, {
        ...event.payload,
        connection: { kind: "selected", connectionId: null },
        creator: { kind: "user" },
      }),
    ),
  };
}

describe("Spaces", () => {
  it("requires every ordinary folder to be born in a persisted Space", async () => {
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), "personal", "Personal"))
      .readModel;
    ({ readModel } = await addFolder(readModel, "ideas", SpaceId.makeUnsafe("personal")));
    expect(readModel.folders[0]).toMatchObject({
      id: "ideas",
      workspaceRoot: null,
      spaceId: "personal",
    });
  });

  it("rejects dangling Space ids instead of degrading them", async () => {
    await expect(
      addFolder(createEmptyReadModel(CREATED_AT), "dangling", SpaceId.makeUnsafe("missing-space")),
    ).rejects.toThrow(/does not exist/i);
  });

  it("requires case-insensitively unique folder names within a Space", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), personal, "Personal"))
      .readModel;
    ({ readModel } = await addNamedFolder(readModel, "first", "Product", personal));

    await expect(addNamedFolder(readModel, "second", " product ", personal)).rejects.toThrow(
      /already exists in this Space/i,
    );
  });

  it("archives a non-empty Space while preserving its content assignments", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), personal, "Personal"))
      .readModel;
    ({ readModel } = await addSpace(readModel, "work", "Work"));
    ({ readModel } = await addFolder(readModel, "ideas", personal));
    ({ readModel } = await addThread({
      readModel,
      id: "personal-chat",
      folderId: FolderId.makeUnsafe("ideas"),
    }));

    const archived = await dispatch(readModel, {
      type: "space.archive",
      commandId: CommandId.makeUnsafe("space.archive-owned"),
      spaceId: personal,
    });

    expect(
      archived.readModel.spaces.find((space) => space.id === personal)?.archivedAt,
    ).not.toBeNull();
    expect(archived.readModel.folders.find((project) => project.id === "ideas")?.spaceId).toBe(
      personal,
    );
    expect(
      archived.readModel.threads.find((thread) => thread.id === "personal-chat")?.folderId,
    ).toBe("ideas");
  });

  it("blocks delete while a Space owns live content", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), personal, "Personal"))
      .readModel;
    ({ readModel } = await addSpace(readModel, "work", "Work"));
    ({ readModel } = await addFolder(readModel, "ideas", personal));

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "space.delete",
            commandId: CommandId.makeUnsafe("space.delete-owned"),
            spaceId: personal,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow(/move every folder/i);
  });

  it("allows deleting an empty Space without changing assignments", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    const work = SpaceId.makeUnsafe("work");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), personal, "Personal"))
      .readModel;
    ({ readModel } = await addSpace(readModel, work, "Work"));
    ({ readModel } = await addFolder(readModel, "ideas", personal));

    const result = await dispatch(readModel, {
      type: "space.delete",
      commandId: CommandId.makeUnsafe("delete-empty-work"),
      spaceId: work,
    });
    expect(result.readModel.folders[0]?.spaceId).toBe(personal);
    expect(result.readModel.spaces.find((space) => space.id === work)?.deletedAt).not.toBeNull();
  });

  it("keeps at least one active Space", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    const readModel = (await addSpace(createEmptyReadModel(CREATED_AT), personal, "Personal"))
      .readModel;
    for (const type of ["space.archive", "space.delete"] as const) {
      await expect(
        Effect.runPromise(
          decideOrchestrationCommand({
            command: {
              type,
              commandId: CommandId.makeUnsafe(`${type}-last`),
              spaceId: personal,
            },
            readModel,
          }),
        ),
      ).rejects.toThrow(/at least one active Space/i);
    }
  });

  it("allows reuse of an archived name but requires a rename on restore", async () => {
    const archivedId = SpaceId.makeUnsafe("old-work");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), archivedId, "Work"))
      .readModel;
    ({ readModel } = await addSpace(readModel, "personal", "Personal"));
    ({ readModel } = await dispatch(readModel, {
      type: "space.archive",
      commandId: CommandId.makeUnsafe("archive-old-work"),
      spaceId: archivedId,
    }));
    ({ readModel } = await addSpace(readModel, "new-work", "work"));

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "space.restore",
            commandId: CommandId.makeUnsafe("restore-conflict"),
            spaceId: archivedId,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow(/already exists/i);

    const restored = await dispatch(readModel, {
      type: "space.restore",
      commandId: CommandId.makeUnsafe("restore-renamed"),
      spaceId: archivedId,
      name: "Previous Work",
    });
    expect(restored.readModel.spaces.find((space) => space.id === archivedId)).toMatchObject({
      name: "Previous Work",
      archivedAt: null,
    });
  });

  it("moves folders atomically between real Spaces", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    const work = SpaceId.makeUnsafe("work");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), personal, "Personal"))
      .readModel;
    ({ readModel } = await addSpace(readModel, work, "Work"));
    ({ readModel } = await addFolder(readModel, "first", personal));
    ({ readModel } = await addFolder(readModel, "second", work));

    const moved = await dispatch(readModel, {
      type: "folder.move",
      commandId: CommandId.makeUnsafe("move-folders"),
      spaceId: work,
      folderIds: [FolderId.makeUnsafe("first"), FolderId.makeUnsafe("second")],
    });
    expect(moved.events).toHaveLength(1);
    expect(moved.readModel.folders.map((project) => project.spaceId)).toEqual([work, work]);
  });

  it("archives and restores a folder without changing its threads", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    const folderId = FolderId.makeUnsafe("folder");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), personal, "Personal"))
      .readModel;
    ({ readModel } = await addFolder(readModel, folderId, personal));
    ({ readModel } = await addThread({ readModel, id: "thread", folderId }));
    const originalThread = readModel.threads[0];

    ({ readModel } = await dispatch(readModel, {
      type: "folder.update",
      commandId: CommandId.makeUnsafe("archive-folder"),
      folderId,
      archivedAt: "2026-08-02T11:00:00.000Z",
    }));

    expect(readModel.folders[0]?.archivedAt).toBe("2026-08-02T11:00:00.000Z");
    expect(readModel.threads[0]).toEqual(originalThread);

    ({ readModel } = await dispatch(readModel, {
      type: "folder.update",
      commandId: CommandId.makeUnsafe("restore-folder"),
      folderId,
      archivedAt: null,
    }));

    expect(readModel.folders[0]?.archivedAt).toBeNull();
    expect(readModel.threads[0]).toEqual(originalThread);
  });
});
