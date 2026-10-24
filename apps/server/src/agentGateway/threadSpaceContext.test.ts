import { FolderId, SpaceId, ThreadId, type OrchestrationFolderShell } from "@penkra/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { ThreadReadsShape } from "../cleanCore/ThreadReads.ts";
import { requireThreadSpaceId, resolveThreadSpaceId } from "./threadSpaceContext.ts";

const threadId = ThreadId.make("thread-1");
const folderId = FolderId.make("folder-1");
const personal = SpaceId.make("penkra-personal");
const folder = { id: folderId, spaceId: personal } as unknown as OrchestrationFolderShell;

function snapshotQueryFor(value: OrchestrationFolderShell): ThreadReadsShape {
  return {
    getFolderShellById: () => Effect.succeed(Option.some(value)),
  } as unknown as ThreadReadsShape;
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
