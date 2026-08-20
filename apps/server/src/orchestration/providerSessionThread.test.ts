import type { OrchestrationThread, ThreadId } from "@penkra/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import { resolveProviderSessionThread } from "./providerSessionThread.ts";

describe("resolveProviderSessionThread", () => {
  it("propagates lookup failure, then resolves the parent provider thread", async () => {
    const parentId = "thread-parent" as ThreadId;
    const childId = "subagent:thread-parent:child" as ThreadId;
    const parent = { id: parentId, parentThreadId: null } as OrchestrationThread;
    const child = { id: childId, parentThreadId: parentId } as OrchestrationThread;
    let childLookups = 0;
    const getThreadDetailById = vi.fn((threadId: ThreadId) => {
      if (threadId === childId && childLookups++ === 0) {
        return Effect.fail(new Error("transient projection failure"));
      }
      return Effect.succeed(Option.some(threadId === childId ? child : parent));
    });
    const projectionSnapshotQuery = {
      getThreadDetailById,
      findSyntheticSubagentParentThread: () => Effect.succeed(Option.none()),
    } as unknown as ProjectionSnapshotQueryShape;

    await expect(
      Effect.runPromise(
        Effect.flip(resolveProviderSessionThread(projectionSnapshotQuery, childId)),
      ),
    ).resolves.toMatchObject({ message: "transient projection failure" });

    const resolved = await Effect.runPromise(
      resolveProviderSessionThread(projectionSnapshotQuery, childId),
    );
    expect(resolved?.id).toBe(parentId);
    expect(getThreadDetailById).toHaveBeenCalledWith(parentId);
  });
});
