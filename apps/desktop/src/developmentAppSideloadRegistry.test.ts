import { describe, expect, it, vi } from "vitest";

import { DevelopmentAppSideloadRegistry } from "./developmentAppSideloadRegistry";

describe("DevelopmentAppSideloadRegistry", () => {
  it("keeps independent watchers for multiple runtime-loaded Apps", async () => {
    const reloads = new Map<string, () => Promise<void>>();
    const closes = new Map<string, ReturnType<typeof vi.fn>>();
    const load = vi.fn(async (_runtime, sourcePath: string, spaceId: string) => ({
      appId: sourcePath.endsWith("canvas") ? "com.penkra.canvas" : "com.penkra.explorer",
      sourcePath,
      spaceId,
      status: "installed" as const,
    }));
    const registry = new DevelopmentAppSideloadRegistry({
      runtime: {} as never,
      load: load as never,
      watch: ((input: { sourcePath: string; reload: () => Promise<void> }) => {
        reloads.set(input.sourcePath, input.reload);
        const close = vi.fn(async () => undefined);
        closes.set(input.sourcePath, close);
        return { close };
      }) as never,
    });

    await registry.register("/work/canvas", "personal");
    await registry.register("/work/explorer", "personal");

    expect(reloads.size).toBe(2);
    await reloads.get("/work/canvas")?.();
    expect(load).toHaveBeenCalledTimes(3);
    await registry.close();
    expect(closes.get("/work/canvas")).toHaveBeenCalledOnce();
    expect(closes.get("/work/explorer")).toHaveBeenCalledOnce();
  });

  it("moves one App and Space registration to its newly selected directory", async () => {
    const firstClose = vi.fn(async () => undefined);
    let calls = 0;
    const registry = new DevelopmentAppSideloadRegistry({
      runtime: {} as never,
      load: vi.fn(async (_runtime, sourcePath: string, spaceId: string) => ({
        appId: "com.penkra.canvas",
        sourcePath,
        spaceId,
        status: calls++ === 0 ? ("installed" as const) : ("updated" as const),
      })) as never,
      watch: vi
        .fn()
        .mockReturnValueOnce({ close: firstClose })
        .mockReturnValue({ close: vi.fn(async () => undefined) }) as never,
    });

    await registry.register("/work/canvas-a", "personal");
    await registry.register("/work/canvas-b", "personal");

    expect(firstClose).toHaveBeenCalledOnce();
    await registry.close();
  });

  it("keeps a watcher active after a rejected rebuild", async () => {
    const onError = vi.fn();
    let reload: (() => Promise<void>) | undefined;
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        appId: "com.penkra.canvas",
        sourcePath: "/work/canvas",
        spaceId: "personal",
        status: "installed",
      })
      .mockRejectedValueOnce(new Error("invalid rebuild"));
    const registry = new DevelopmentAppSideloadRegistry({
      runtime: {} as never,
      load,
      onError,
      watch: ((input: { reload: () => Promise<void>; onError: (error: unknown) => void }) => {
        reload = async () => input.reload().catch(input.onError);
        return { close: vi.fn(async () => undefined) };
      }) as never,
    });

    await registry.register("/work/canvas", "personal");
    await reload?.();

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "invalid rebuild" }), {
      appId: "com.penkra.canvas",
      sourcePath: "/work/canvas",
      spaceId: "personal",
    });
    await registry.close();
  });
});
