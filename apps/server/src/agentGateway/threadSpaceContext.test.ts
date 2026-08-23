import { FolderId, SpaceId, ThreadId, type OrchestrationFolderShell } from "@penkra/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { requireThreadSpaceId, resolveThreadSpaceId } from "./threadSpaceContext.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
const folderId = FolderId.makeUnsafe("folder-1");
const personal = SpaceId.makeUnsafe("penkra-personal");
const folder = { id: folderId, spaceId: personal } as unknown as OrchestrationFolderShell;

function snapshotQueryFor(value: OrchestrationFolderShell): ProjectionSnapshotQueryShape {
  return {
    getFolderShellById: () => Effect.succeed(Option.some(value)),
  } as unknown as ProjectionSnapshotQueryShape;
}

describe("resolveThreadSpaceId", () => {
  it("uses the parent folder's required Space", () => {
    expect(resolveThreadSpaceId({ thread: { id: threadId, folderId }, folder })).toBe(personal);
  });

  it("resolves the hierarchy through the Effect service boundary", async () => {
    await expect(
      Effect.runPromise(
        requireThreadSpaceId(snapshotQueryFor(folder), {
          id: threadId,
          folderId,
        }),
      ),
    ).resolves.toBe(personal);
  });
});
