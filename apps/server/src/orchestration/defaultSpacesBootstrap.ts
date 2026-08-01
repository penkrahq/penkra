// FILE: defaultSpacesBootstrap.ts
// Purpose: Creates the two first-run Spaces through the normal event-sourced command path.

import { CommandId, SpaceId, type OrchestrationCommand } from "@synara/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

const DEFAULT_SPACES = [
  { id: "penkra-personal", name: "Personal", icon: "home" },
  { id: "penkra-work", name: "Work", icon: "bag" },
] as const;

/**
 * Bootstrap only a truly new history. Deleted or later archived Spaces remain
 * intentional user state and must never cause the defaults to reappear.
 */
export const ensureDefaultSpaces = (engine: OrchestrationEngineShape) =>
  Effect.gen(function* () {
    const readModel = yield* engine.getReadModel();
    if (readModel.spaces.length > 0) return;

    const createdAt = new Date().toISOString();
    for (const space of DEFAULT_SPACES) {
      const command = {
        type: "space.create",
        commandId: CommandId.makeUnsafe(`bootstrap:${space.id}`),
        spaceId: SpaceId.makeUnsafe(space.id),
        name: space.name,
        icon: space.icon,
        createdAt,
      } satisfies OrchestrationCommand;
      yield* engine.dispatch(command);
    }
  });
