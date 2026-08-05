import type { OrchestrationCommand } from "@penkra/contracts";
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
    const dispatch = vi.fn((_command: OrchestrationCommand) => Effect.succeed(undefined));
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
    const dispatch = vi.fn((_command: OrchestrationCommand) => Effect.succeed(undefined));
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
    expect(dispatch.mock.calls[0]?.[0]?.commandId).toMatch(
      /^penkra:project:update:penkra-client-client-1:[0-9a-f]{64}$/,
    );
  });

  it("derives the registry command identity from the complete durable command intent", async () => {
    const dispatch = vi.fn((_command: OrchestrationCommand) => Effect.succeed(undefined));
    const engine = {
      getReadModel: () =>
        Effect.succeed({
          projects: [
            {
              id: "penkra-hq",
              title: "Penkra HQ",
              isPinned: false,
              spaceId: "penkra-personal",
              deletedAt: null,
            },
          ],
        }),
      dispatch,
    } as never;
    const desired = {
      id: "penkra-hq",
      title: "Penkra HQ",
      isPinned: true,
      enforcePin: true,
    };

    await ensureRegistryFolder(engine, desired);
    await ensureRegistryFolder(engine, desired);

    const first = dispatch.mock.calls[0]?.[0];
    const second = dispatch.mock.calls[1]?.[0];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error("Expected two registry update commands.");
    expect(first.commandId).toBe(second.commandId);
    expect(first.commandId).toMatch(/^penkra:project:update:penkra-hq:[0-9a-f]{64}$/);
    expect(first).toEqual(
      expect.objectContaining({
        type: "project.meta.update",
        projectId: "penkra-hq",
        title: "Penkra HQ",
        spaceId: "penkra-personal",
        isPinned: true,
      }),
    );
  });
});
