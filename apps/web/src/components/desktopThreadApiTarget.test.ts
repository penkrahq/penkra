import { describe, expect, it, vi } from "vitest";

import {
  composerConflictCode,
  openLinkedThreadAndCompose,
  requireLinkedThreadTarget,
} from "./desktopThreadApiTarget";

describe("linked App Thread targeting", () => {
  it("accepts an active Thread whose Space is inherited from its folder", () => {
    const target = { id: "thread-1", folderId: "folder-1", spaceId: null };
    expect(
      requireLinkedThreadTarget({
        target,
        folders: [{ id: "folder-1", spaceId: "space-1" }],
        spaceId: "space-1",
      }),
    ).toBe(target);
  });

  it("opens the target and composes only after it mounts", async () => {
    const calls: string[] = [];
    const result = await openLinkedThreadAndCompose({
      target: { id: "thread-1", folderId: "folder-1" },
      composition: { text: "Pause playbooks://run/run-1" },
      navigate: async () => void calls.push("navigate"),
      targetAvailable: () => true,
      waitForMount: async () => void calls.push("mount"),
      compose: async (_threadId, composition) => {
        calls.push("compose");
        return { composeId: "compose-1", text: composition.text };
      },
    });

    expect(calls).toEqual(["navigate", "mount", "compose"]);
    expect(result).toEqual({
      threadId: "thread-1",
      composition: { composeId: "compose-1", text: "Pause playbooks://run/run-1" },
    });
  });

  it("reports a target that disappears during navigation", async () => {
    await expect(
      openLinkedThreadAndCompose({
        target: { id: "thread-1", folderId: "folder-1" },
        navigate: async () => undefined,
        targetAvailable: () => false,
        waitForMount: async () => undefined,
        compose: async () => ({ composeId: "unreachable" }),
      }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });

  it("normalizes router failures without attempting composition", async () => {
    const compose = vi.fn();
    await expect(
      openLinkedThreadAndCompose({
        target: { id: "thread-1", folderId: "folder-1" },
        composition: { text: "Resume playbooks://run/run-1" },
        navigate: async () => {
          throw new Error("router rejected navigation");
        },
        targetAvailable: () => true,
        waitForMount: async () => undefined,
        compose,
      }),
    ).rejects.toMatchObject({ code: "THREAD_NAVIGATION_FAILED" });
    expect(compose).not.toHaveBeenCalled();
  });

  it("rejects missing, archived, and cross-Space Threads", () => {
    expect(() =>
      requireLinkedThreadTarget({ target: undefined, folders: [], spaceId: "space-1" }),
    ).toThrow(expect.objectContaining({ code: "THREAD_NOT_FOUND" }));
    expect(() =>
      requireLinkedThreadTarget({
        target: { id: "thread-1", folderId: "folder-1", archivedAt: "2026-01-01" },
        folders: [],
        spaceId: "space-1",
      }),
    ).toThrow(expect.objectContaining({ code: "THREAD_NOT_FOUND" }));
    expect(() =>
      requireLinkedThreadTarget({
        target: { id: "thread-1", folderId: "folder-2", spaceId: "space-2" },
        folders: [],
        spaceId: "space-1",
      }),
    ).toThrow(expect.objectContaining({ code: "THREAD_ACCESS_DENIED" }));
  });

  it("reports the specific owner of an unavailable composer", () => {
    expect(
      composerConflictCode({
        composer: { empty: false },
        phase: "idle",
        queued: { count: 0 },
        pendingQuestion: false,
      }),
    ).toBe("COMPOSER_NOT_EMPTY");
    expect(
      composerConflictCode({
        composer: { empty: true },
        phase: "running",
        queued: { count: 0 },
        pendingQuestion: false,
      }),
    ).toBeNull();
    expect(
      composerConflictCode({
        composer: { empty: true },
        phase: "idle",
        queued: { count: 1 },
        pendingQuestion: false,
      }),
    ).toBe("THREAD_HAS_QUEUED_COMPOSITION");
    expect(
      composerConflictCode({
        composer: { empty: true },
        phase: "waiting",
        queued: { count: 0 },
        pendingQuestion: true,
      }),
    ).toBe("THREAD_WAITING_FOR_USER");
  });
});
