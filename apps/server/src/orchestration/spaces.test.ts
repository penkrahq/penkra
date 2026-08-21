// FILE: spaces.test.ts
// Purpose: Covers the clean persisted-Space lifecycle and folder assignment invariants.

import {
  CommandId,
  ContainerId,
  SpaceId,
  ThreadId,
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
    type: "project.create",
    commandId: CommandId.makeUnsafe(`create-${id}`),
    projectId: ContainerId.makeUnsafe(id),
    title: id,
    workspaceRoot: null,
    spaceId,
    createdAt: CREATED_AT,
  });
}

async function addNamedFolder(readModel: ReadModel, id: string, title: string, spaceId: SpaceId) {
  return dispatch(readModel, {
    type: "project.create",
    commandId: CommandId.makeUnsafe(`create-${id}`),
    projectId: ContainerId.makeUnsafe(id),
    title,
    workspaceRoot: null,
    spaceId,
    createdAt: CREATED_AT,
  });
}

async function addChatContainer(readModel: ReadModel) {
  return dispatch(readModel, {
    type: "project.create",
    commandId: CommandId.makeUnsafe("create-chat-container"),
    projectId: ContainerId.makeUnsafe("chat-container"),
    kind: "chat",
    title: "Chats",
    workspaceRoot: "/tmp/chats",
    createdAt: CREATED_AT,
  });
}

async function addThread(input: {
  readModel: ReadModel;
  id: string;
  projectId: ContainerId;
  spaceId?: SpaceId;
  parentThreadId?: ThreadId;
}) {
  return dispatch(input.readModel, {
    type: "thread.create",
    commandId: CommandId.makeUnsafe(`create-${input.id}`),
    threadId: ThreadId.makeUnsafe(input.id),
    projectId: input.projectId,
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    title: input.id,
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
    createdAt: CREATED_AT,
  });
}

describe("Spaces", () => {
  it("reorders by a stable neighboring Space anchor", async () => {
    const first = SpaceId.makeUnsafe("first");
    const second = SpaceId.makeUnsafe("second");
    const third = SpaceId.makeUnsafe("third");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), first, "First")).readModel;
    ({ readModel } = await addSpace(readModel, second, "Second"));
    ({ readModel } = await addSpace(readModel, third, "Third"));

    const reordered = await dispatch(readModel, {
      type: "space.reorder",
      commandId: CommandId.makeUnsafe("move-third-before-first"),
      spaceId: third,
      position: { type: "before", spaceId: first },
    });

    expect(
      reordered.readModel.spaces
        .toSorted((left, right) => left.sortOrder - right.sortOrder)
        .map((space) => space.id),
    ).toEqual([third, first, second]);
  });

  it("requires every ordinary folder to be born in a persisted Space", async () => {
    await expect(
      dispatch(createEmptyReadModel(CREATED_AT), {
        type: "project.create",
        commandId: CommandId.makeUnsafe("create-unassigned"),
        projectId: ContainerId.makeUnsafe("unassigned"),
        title: "Unassigned",
        workspaceRoot: null,
        createdAt: CREATED_AT,
      }),
    ).rejects.toThrow(/must be created in a persisted Space/i);

    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), "personal", "Personal"))
      .readModel;
    ({ readModel } = await addFolder(readModel, "ideas", SpaceId.makeUnsafe("personal")));
    expect(readModel.projects[0]).toMatchObject({
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

  it("allows the same folder name in different Spaces but rejects rename and move collisions", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    const work = SpaceId.makeUnsafe("work");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), personal, "Personal"))
      .readModel;
    ({ readModel } = await addSpace(readModel, work, "Work"));
    ({ readModel } = await addNamedFolder(readModel, "personal-product", "Product", personal));
    ({ readModel } = await addNamedFolder(readModel, "work-product", "Product", work));
    ({ readModel } = await addNamedFolder(readModel, "work-research", "Research", work));

    await expect(
      dispatch(readModel, {
        type: "project.meta.update",
        commandId: CommandId.makeUnsafe("rename-to-product"),
        projectId: ContainerId.makeUnsafe("work-research"),
        title: "PRODUCT",
      }),
    ).rejects.toThrow(/already exists in this Space/i);

    await expect(
      dispatch(readModel, {
        type: "space.projects.assign",
        commandId: CommandId.makeUnsafe("move-product-to-work"),
        spaceId: work,
        projectIds: [ContainerId.makeUnsafe("personal-product")],
      }),
    ).rejects.toThrow(/already exists in this Space/i);
  });

  it("keeps managed chat containers global and rooted", async () => {
    await expect(
      dispatch(createEmptyReadModel(CREATED_AT), {
        type: "project.create",
        commandId: CommandId.makeUnsafe("create-pathless-chat"),
        projectId: ContainerId.makeUnsafe("pathless-chat"),
        kind: "chat",
        title: "Chats",
        workspaceRoot: null,
        createdAt: CREATED_AT,
      }),
    ).rejects.toThrow(/require a workspace root/i);

    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), "personal", "Personal"))
      .readModel;
    await expect(
      dispatch(readModel, {
        type: "project.create",
        commandId: CommandId.makeUnsafe("create-filed-chat"),
        projectId: ContainerId.makeUnsafe("filed-chat"),
        kind: "chat",
        title: "Chats",
        workspaceRoot: "/tmp/chats",
        spaceId: SpaceId.makeUnsafe("personal"),
        createdAt: CREATED_AT,
      }),
    ).rejects.toThrow(/do not belong to a Space/i);
  });

  it("requires folders to remain assigned", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), personal, "Personal"))
      .readModel;
    ({ readModel } = await addFolder(readModel, "ideas", personal));
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe("clear-folder-space"),
            projectId: ContainerId.makeUnsafe("ideas"),
            spaceId: null,
          },
          readModel,
        }),
      ),
    ).rejects.toThrow(/must remain assigned/i);
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
      projectId: ContainerId.makeUnsafe("ideas"),
    }));

    const archived = await dispatch(readModel, {
      type: "space.archive",
      commandId: CommandId.makeUnsafe("space.archive-owned"),
      spaceId: personal,
    });

    expect(
      archived.readModel.spaces.find((space) => space.id === personal)?.archivedAt,
    ).not.toBeNull();
    expect(archived.readModel.projects.find((project) => project.id === "ideas")?.spaceId).toBe(
      personal,
    );
    expect(
      archived.readModel.threads.find((thread) => thread.id === "personal-chat")?.projectId,
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
    ).rejects.toThrow(/move every folder and chat thread/i);
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
    expect(result.readModel.projects[0]?.spaceId).toBe(personal);
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
      type: "space.projects.assign",
      commandId: CommandId.makeUnsafe("move-folders"),
      spaceId: work,
      projectIds: [ContainerId.makeUnsafe("first"), ContainerId.makeUnsafe("second")],
    });
    expect(moved.events).toHaveLength(1);
    expect(moved.readModel.projects.map((project) => project.spaceId)).toEqual([work, work]);
  });

  it("persists a mixed folder order while moving a folder across Spaces", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    const work = SpaceId.makeUnsafe("work");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), personal, "Personal"))
      .readModel;
    ({ readModel } = await addSpace(readModel, work, "Work"));
    ({ readModel } = await addFolder(readModel, "first", personal));
    ({ readModel } = await addFolder(readModel, "second", work));
    // This row was not part of the drag-start snapshot. Anchor intent must preserve it.
    ({ readModel } = await addFolder(readModel, "third", work));

    const moved = await dispatch(readModel, {
      type: "sidebar.item.move",
      commandId: CommandId.makeUnsafe("move-first-after-second"),
      item: { kind: "project", id: ContainerId.makeUnsafe("first") },
      target: { kind: "space", spaceId: work },
      position: {
        type: "after",
        item: { kind: "project", id: ContainerId.makeUnsafe("second") },
      },
    });

    expect(moved.events).toHaveLength(1);
    expect(
      moved.readModel.projects.map(({ id, spaceId, sidebarSortOrder }) => ({
        id,
        spaceId,
        sidebarSortOrder,
      })),
    ).toEqual([
      { id: "first", spaceId: work, sidebarSortOrder: 1 },
      { id: "second", spaceId: work, sidebarSortOrder: 0 },
      { id: "third", spaceId: work, sidebarSortOrder: 2 },
    ]);
  });

  it("moves a root thread and its child tree into a folder atomically", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), personal, "Personal"))
      .readModel;
    ({ readModel } = await addChatContainer(readModel));
    ({ readModel } = await addFolder(readModel, "folder", personal));
    ({ readModel } = await addThread({
      readModel,
      id: "root-thread",
      projectId: ContainerId.makeUnsafe("folder"),
    }));
    ({ readModel } = await addThread({
      readModel,
      id: "child-thread",
      projectId: ContainerId.makeUnsafe("folder"),
      parentThreadId: ThreadId.makeUnsafe("root-thread"),
    }));
    // Simulate the legacy pre-migration shape; new commands can no longer create it.
    readModel = {
      ...readModel,
      threads: readModel.threads.map((thread) => ({
        ...thread,
        projectId: ContainerId.makeUnsafe("chat-container"),
        spaceId: personal,
      })),
    };

    const moved = await dispatch(readModel, {
      type: "sidebar.item.move",
      commandId: CommandId.makeUnsafe("move-thread-tree"),
      item: { kind: "thread", id: ThreadId.makeUnsafe("root-thread") },
      target: { kind: "project", projectId: ContainerId.makeUnsafe("folder") },
      position: { type: "pinned-boundary" },
    });

    expect(
      moved.readModel.threads.map(({ id, projectId, spaceId }) => ({ id, projectId, spaceId })),
    ).toEqual([
      { id: "root-thread", projectId: "folder", spaceId: null },
      { id: "child-thread", projectId: "folder", spaceId: null },
    ]);
  });

  it("rejects creating or moving a thread directly under a Space", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), personal, "Personal"))
      .readModel;
    ({ readModel } = await addChatContainer(readModel));
    ({ readModel } = await addFolder(readModel, "folder", personal));

    await expect(
      addThread({
        readModel,
        id: "loose-thread",
        projectId: ContainerId.makeUnsafe("chat-container"),
        spaceId: personal,
      }),
    ).rejects.toThrow(/inside a folder/i);

    ({ readModel } = await addThread({
      readModel,
      id: "filed-thread",
      projectId: ContainerId.makeUnsafe("folder"),
    }));
    await expect(
      dispatch(readModel, {
        type: "sidebar.item.move",
        commandId: CommandId.makeUnsafe("move-thread-to-space"),
        item: { kind: "thread", id: ThreadId.makeUnsafe("filed-thread") },
        target: { kind: "space", spaceId: personal },
        position: { type: "pinned-boundary" },
      }),
    ).rejects.toThrow(/into a folder/i);
  });

  it("rejects positioning an unpinned item inside the pinned block", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), personal, "Personal"))
      .readModel;
    ({ readModel } = await addFolder(readModel, "pinned", personal));
    ({ readModel } = await addFolder(readModel, "regular", personal));
    ({ readModel } = await dispatch(readModel, {
      type: "project.meta.update",
      commandId: CommandId.makeUnsafe("pin-folder"),
      projectId: ContainerId.makeUnsafe("pinned"),
      isPinned: true,
    }));

    await expect(
      dispatch(readModel, {
        type: "sidebar.item.move",
        commandId: CommandId.makeUnsafe("cross-pin-boundary"),
        item: { kind: "project", id: ContainerId.makeUnsafe("regular") },
        target: { kind: "space", spaceId: personal },
        position: {
          type: "before",
          item: { kind: "project", id: ContainerId.makeUnsafe("pinned") },
        },
      }),
    ).rejects.toThrow(/cannot be interleaved/i);
  });

  it("archives and restores a folder without changing its threads", async () => {
    const personal = SpaceId.makeUnsafe("personal");
    const projectId = ContainerId.makeUnsafe("folder");
    let readModel = (await addSpace(createEmptyReadModel(CREATED_AT), personal, "Personal"))
      .readModel;
    ({ readModel } = await addFolder(readModel, projectId, personal));
    ({ readModel } = await addThread({ readModel, id: "thread", projectId }));
    const originalThread = readModel.threads[0];

    ({ readModel } = await dispatch(readModel, {
      type: "project.meta.update",
      commandId: CommandId.makeUnsafe("archive-folder"),
      projectId,
      archivedAt: "2026-08-02T11:00:00.000Z",
    }));

    expect(readModel.projects[0]?.archivedAt).toBe("2026-08-02T11:00:00.000Z");
    expect(readModel.threads[0]).toEqual(originalThread);

    ({ readModel } = await dispatch(readModel, {
      type: "project.meta.update",
      commandId: CommandId.makeUnsafe("restore-folder"),
      projectId,
      archivedAt: null,
    }));

    expect(readModel.projects[0]?.archivedAt).toBeNull();
    expect(readModel.threads[0]).toEqual(originalThread);
  });
});
