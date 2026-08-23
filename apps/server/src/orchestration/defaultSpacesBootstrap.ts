// FILE: defaultSpacesBootstrap.ts
// Purpose: Creates the first-run Spaces and starter folders through the event-sourced command path.

import { CommandId, FolderId, SpaceId, type OrchestrationCommand } from "@penkra/contracts";
import { Effect } from "effect";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

const DEFAULT_SPACES = [
  { id: "penkra-personal", name: "Personal", icon: "home" },
  { id: "penkra-work", name: "Work", icon: "bag" },
] as const;

const DEFAULT_FOLDER = { idSuffix: "default", title: "Default" } as const;

/**
 * Bootstrap only a truly new history. Deleted or later archived Spaces remain
 * intentional user state and must never cause the defaults to reappear.
 */
export const ensureDefaultSpaces = (engine: OrchestrationEngineShape) =>
  Effect.gen(function* () {
    const readModel = yield* engine.getCommandReadModel();
    const isNewSpaceHistory = readModel.spaces.length === 0;
    if (isNewSpaceHistory) {
      const createdAt = new Date().toISOString();
      for (const space of DEFAULT_SPACES) {
        const spaceId = SpaceId.makeUnsafe(space.id);
        const createSpaceCommand = {
          type: "space.create",
          commandId: CommandId.makeUnsafe(`bootstrap:${space.id}`),
          spaceId,
          name: space.name,
          icon: space.icon,
          createdAt,
        } satisfies OrchestrationCommand;
        yield* engine.dispatch(createSpaceCommand);

        const folderId = FolderId.makeUnsafe(`${space.id}-${DEFAULT_FOLDER.idSuffix}`);
        const createFolderCommand = {
          type: "folder.create",
          commandId: CommandId.makeUnsafe(`bootstrap:${folderId}`),
          folderId,
          title: DEFAULT_FOLDER.title,
          workspaceRoot: null,
          spaceId,
          createdAt,
        } satisfies OrchestrationCommand;
        yield* engine.dispatch(createFolderCommand);
      }
    }
  });
