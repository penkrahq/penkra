import { SpaceId, type OrchestrationCommand } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ensureDefaultSpaces } from "./defaultSpacesBootstrap.ts";
import { createEmptyReadModel } from "./projector.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

function engineFor(spaces: ReturnType<typeof createEmptyReadModel>["spaces"]) {
  const dispatched: OrchestrationCommand[] = [];
  const dispatch = vi.fn((command: OrchestrationCommand) => {
    dispatched.push(command);
    return Effect.succeed({ sequence: dispatched.length });
  });
  const engine = {
    getReadModel: () =>
      Effect.succeed({ ...createEmptyReadModel("2026-07-31T00:00:00.000Z"), spaces }),
    dispatch,
  } as unknown as OrchestrationEngineShape;
  return { dispatch, dispatched, engine };
}

describe("default Spaces bootstrap", () => {
  it("creates Personal then Work through durable commands for a new history", async () => {
    const { dispatched, engine } = engineFor([]);

    await Effect.runPromise(ensureDefaultSpaces(engine));

    expect(dispatched.map((command) => command.type)).toEqual(["space.create", "space.create"]);
    expect(
      dispatched.map((command) =>
        command.type === "space.create" ? [command.spaceId, command.name, command.icon] : null,
      ),
    ).toEqual([
      ["penkra-personal", "Personal", "home"],
      ["penkra-work", "Work", "bag"],
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
});
