import { SpaceId, type OrchestrationCommand } from "@penkra/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ensureDefaultSpaces } from "./defaultSpacesBootstrap.ts";
import { createEmptyReadModel } from "./projector.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

function engineFor(
  spaces: ReturnType<typeof createEmptyReadModel>["spaces"],
  overrides?: Partial<ReturnType<typeof createEmptyReadModel>>,
) {
  const dispatched: OrchestrationCommand[] = [];
  const dispatch = vi.fn((command: OrchestrationCommand) => {
    dispatched.push(command);
    return Effect.succeed({ sequence: dispatched.length });
  });
  const getReadModel = () =>
    Effect.succeed({
      ...createEmptyReadModel("2026-07-31T00:00:00.000Z"),
      ...overrides,
      spaces,
    });
  const engine = {
    getReadModel,
    getCommandReadModel: getReadModel,
    dispatch,
  } as unknown as OrchestrationEngineShape;
  return { dispatch, dispatched, engine };
}

describe("default Spaces bootstrap", () => {
  it("creates Personal and Work with one Default folder each through durable commands", async () => {
    const { dispatched, engine } = engineFor([]);

    await Effect.runPromise(ensureDefaultSpaces(engine));

    expect(dispatched.map((command) => command.type)).toEqual([
      "space.create",
      "folder.create",
      "space.create",
      "folder.create",
    ]);
    expect(
      dispatched.map((command) =>
        command.type === "space.create" ? [command.spaceId, command.name, command.icon] : null,
      ),
    ).toEqual([
      ["penkra-personal", "Personal", "home"],
      null,
      ["penkra-work", "Work", "bag"],
      null,
    ]);
    expect(
      dispatched.flatMap((command) =>
        command.type === "folder.create"
          ? [[command.folderId, command.title, command.spaceId, command.workspaceRoot]]
          : [],
      ),
    ).toEqual([
      ["penkra-personal-default", "Default", "penkra-personal", null],
      ["penkra-work-default", "Default", "penkra-work", null],
    ]);
  });

  it("does not recreate defaults when Space history already exists", async () => {
    const existing = {
      id: SpaceId.makeUnsafe("existing"),
      name: "Existing",
      icon: "star",
      sortOrder: 0,
      createdAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      deletedAt: "2026-07-31T01:00:00.000Z",
    } as const;
    const { dispatch, engine } = engineFor([existing]);

    await Effect.runPromise(ensureDefaultSpaces(engine));

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not restore archived defaults or migrate records at runtime", async () => {
    const timestamp = "2026-07-31T00:00:00.000Z";
    const personalId = SpaceId.makeUnsafe("penkra-personal");
    const workId = SpaceId.makeUnsafe("penkra-work");
    const archivedAt = "2026-07-31T01:00:00.000Z";
    const spaces = [
      {
        id: personalId,
        name: "Personal",
        icon: "home" as const,
        sortOrder: 0,
        createdAt: timestamp,
        updatedAt: archivedAt,
        archivedAt,
        deletedAt: null,
      },
      {
        id: workId,
        name: "Work",
        icon: "bag" as const,
        sortOrder: 1,
        createdAt: timestamp,
        updatedAt: archivedAt,
        archivedAt,
        deletedAt: null,
      },
    ];
    const { dispatched, engine } = engineFor(spaces);

    await Effect.runPromise(ensureDefaultSpaces(engine));

    expect(dispatched).toEqual([]);
  });
});
