import { ContainerId, SpaceId, ThreadId } from "@penkra/contracts";
import type { OrchestrationProjectShell } from "@penkra/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { requireThreadSpaceId, resolveThreadSpaceId } from "./threadSpaceContext.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
const projectId = ContainerId.makeUnsafe("project-1");
const personal = SpaceId.makeUnsafe("penkra-personal");
const work = SpaceId.makeUnsafe("penkra-work");

function snapshotQueryFor(project: OrchestrationProjectShell): ProjectionSnapshotQueryShape {
  return {
    getProjectShellById: () => Effect.succeed(Option.some(project)),
  } as unknown as ProjectionSnapshotQueryShape;
}

describe("resolveThreadSpaceId", () => {
  it("uses the parent project's Space for project-backed Threads", () => {
    expect(
      resolveThreadSpaceId({
        thread: { id: threadId, projectId, spaceId: null },
        project: { id: projectId, spaceId: personal },
      }),
    ).toBe(personal);
  });

  it("uses a loose chat Thread's direct Space", () => {
    expect(
      resolveThreadSpaceId({
        thread: { id: threadId, projectId, spaceId: personal },
        project: { id: projectId, spaceId: personal },
      }),
    ).toBe(personal);
  });

  it("rejects inconsistent Thread and project Spaces", () => {
    expect(() =>
      resolveThreadSpaceId({
        thread: { id: threadId, projectId, spaceId: personal },
        project: { id: projectId, spaceId: work },
      }),
    ).toThrow('belongs to Space "penkra-personal"');
  });

  it("rejects an unassigned hierarchy instead of guessing", () => {
    expect(() =>
      resolveThreadSpaceId({
        thread: { id: threadId, projectId, spaceId: null },
        project: { id: projectId, spaceId: null },
      }),
    ).toThrow("Neither Thread");
  });

  it("resolves a project-backed Thread through the Effect service boundary", async () => {
    const project = {
      id: projectId,
      spaceId: personal,
    } as OrchestrationProjectShell;

    await expect(
      Effect.runPromise(
        requireThreadSpaceId(snapshotQueryFor(project), {
          id: threadId,
          projectId,
          spaceId: null,
        }),
      ),
    ).resolves.toBe(personal);
  });

  it("preserves a useful failure through the Effect service boundary", async () => {
    const project = {
      id: projectId,
      spaceId: null,
    } as OrchestrationProjectShell;

    await expect(
      Effect.runPromise(
        requireThreadSpaceId(snapshotQueryFor(project), {
          id: threadId,
          projectId,
          spaceId: null,
        }),
      ),
    ).rejects.toThrow("Neither Thread");
  });
});
