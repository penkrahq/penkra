import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { coalesceRegistryReconciliations, ensureRegistryFolder } from "./registrySync";

describe("registry reconciliation scheduling", () => {
  it("coalesces overlapping requests into one trailing reconciliation", async () => {
    let runs = 0;
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcile = coalesceRegistryReconciliations(async () => {
      runs += 1;
      if (runs === 1) await first;
      return runs;
    });

    const running = reconcile();
    expect(reconcile()).toBe(running);
    release();
    await expect(running).resolves.toBe(2);
    expect(runs).toBe(2);
  });
});

describe("registry Folder projection", () => {
  it("creates a virtual Folder in Personal without attaching the physical client directory", async () => {
    const dispatch = vi.fn(() => Effect.succeed(undefined));
    await ensureRegistryFolder(
      {
        getReadModel: () => Effect.succeed({ projects: [] }),
        dispatch,
      } as never,
      {
        id: "penkra-client-client-1",
        title: "Client One",
        isPinned: false,
        enforcePin: false,
      },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.create",
        projectId: "penkra-client-client-1",
        title: "Client One",
        workspaceRoot: null,
        spaceId: "penkra-personal",
      }),
    );
  });

  it("moves an existing legacy client Folder into Personal", async () => {
    const dispatch = vi.fn(() => Effect.succeed(undefined));
    await ensureRegistryFolder(
      {
        getReadModel: () =>
          Effect.succeed({
            projects: [
              {
                id: "penkra-client-client-1",
                title: "Client One",
                isPinned: false,
                spaceId: null,
                deletedAt: null,
              },
            ],
          }),
        dispatch,
      } as never,
      {
        id: "penkra-client-client-1",
        title: "Client One",
        isPinned: false,
        enforcePin: false,
      },
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.meta.update",
        projectId: "penkra-client-client-1",
        spaceId: "penkra-personal",
      }),
    );
  });
});
