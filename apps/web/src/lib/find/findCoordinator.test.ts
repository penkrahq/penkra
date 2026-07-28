import { describe, expect, it, vi } from "vitest";
import { FindCoordinator, type FindSurface, type FindSurfaceResult } from "./findCoordinator";

function surface(
  id: string,
  order: number,
  count: number,
  visible = true,
): FindSurface & {
  activate: ReturnType<typeof vi.fn<(matchIndex: number) => void>>;
} {
  const activate = vi.fn<(matchIndex: number) => void>();
  return {
    id,
    order,
    isVisible: () => visible,
    search: vi.fn((): FindSurfaceResult => ({ count })),
    activate,
    clear: vi.fn(),
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("FindCoordinator", () => {
  it("aggregates visible surfaces in visual order and wraps navigation", async () => {
    const coordinator = new FindCoordinator();
    const right = surface("right", 20, 2);
    const left = surface("left", 10, 1);
    const hidden = surface("hidden", 0, 9, false);
    coordinator.register(right);
    coordinator.register(left);
    coordinator.register(hidden);

    coordinator.setQuery("needle");
    await settle();
    expect(coordinator.getSnapshot()).toEqual({
      query: "needle",
      current: 1,
      total: 3,
      pending: false,
    });
    expect(left.activate).toHaveBeenLastCalledWith(0);
    expect(hidden.search).not.toHaveBeenCalled();

    await coordinator.next();
    expect(right.activate).toHaveBeenLastCalledWith(0);
    expect(coordinator.getSnapshot().current).toBe(2);
    await coordinator.next();
    expect(right.activate).toHaveBeenLastCalledWith(1);
    await coordinator.next();
    expect(left.activate).toHaveBeenLastCalledWith(0);
    expect(coordinator.getSnapshot().current).toBe(1);
    await coordinator.previous();
    expect(right.activate).toHaveBeenLastCalledWith(1);
    expect(coordinator.getSnapshot().current).toBe(3);
  });

  it("ignores stale asynchronous searches", async () => {
    const deferred: { resolveFirst?: (value: FindSurfaceResult) => void } = {};
    const coordinator = new FindCoordinator();
    coordinator.register({
      id: "async",
      order: 0,
      isVisible: () => true,
      search: (query) =>
        query === "first"
          ? new Promise((resolve) => {
              deferred.resolveFirst = resolve;
            })
          : { count: 2 },
      activate: vi.fn(),
      clear: vi.fn(),
    });

    coordinator.setQuery("first");
    coordinator.setQuery("second");
    await settle();
    expect(coordinator.getSnapshot().query).toBe("second");
    expect(coordinator.getSnapshot().total).toBe(2);
    deferred.resolveFirst?.({ count: 8 });
    await settle();
    expect(coordinator.getSnapshot().query).toBe("second");
    expect(coordinator.getSnapshot().total).toBe(2);
  });

  it("finishes when a visible surface throws or never settles", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new FindCoordinator();
      const fast = surface("fast", 10, 2);
      coordinator.register({
        id: "broken-visibility",
        order: 0,
        isVisible: () => {
          throw new Error("detached");
        },
        search: vi.fn((): FindSurfaceResult => ({ count: 9 })),
        activate: vi.fn(),
        clear: vi.fn(),
      });
      coordinator.register({
        id: "hung",
        order: 20,
        isVisible: () => true,
        search: () => new Promise<FindSurfaceResult>(() => {}),
        activate: vi.fn(),
        clear: vi.fn(),
      });
      coordinator.register(fast);

      coordinator.setQuery("needle");
      await settle();
      expect(coordinator.getSnapshot()).toEqual({
        query: "needle",
        current: 1,
        total: 2,
        pending: false,
      });

      await vi.advanceTimersByTimeAsync(3_000);
      await settle();
      expect(coordinator.getSnapshot()).toEqual({
        query: "needle",
        current: 1,
        total: 2,
        pending: false,
      });
      expect(fast.activate).toHaveBeenLastCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes when a surface returns an invalid result", async () => {
    const coordinator = new FindCoordinator();
    coordinator.register({
      id: "invalid",
      order: 0,
      isVisible: () => true,
      search: () => undefined as unknown as FindSurfaceResult,
      activate: vi.fn(),
      clear: vi.fn(),
    });

    coordinator.setQuery("needle");
    await settle();
    expect(coordinator.getSnapshot()).toEqual({
      query: "needle",
      current: 0,
      total: 0,
      pending: false,
    });
  });

  it("coalesces invalidations while a search is pending", async () => {
    vi.useFakeTimers();
    try {
      const callbacks: {
        resolveSearch?: (value: FindSurfaceResult) => void;
        invalidate?: () => void;
      } = {};
      const search = vi.fn(
        () =>
          new Promise<FindSurfaceResult>((resolve) => {
            callbacks.resolveSearch = resolve;
          }),
      );
      const coordinator = new FindCoordinator();
      coordinator.register({
        id: "live",
        order: 0,
        isVisible: () => true,
        search,
        activate: vi.fn(),
        clear: vi.fn(),
        subscribeInvalidation: (listener) => {
          callbacks.invalidate = listener;
          return () => {};
        },
      });

      coordinator.setQuery("needle");
      callbacks.invalidate?.();
      callbacks.invalidate?.();
      callbacks.invalidate?.();
      expect(search).toHaveBeenCalledTimes(1);

      callbacks.resolveSearch?.({ count: 1 });
      await settle();
      expect(coordinator.getSnapshot()).toEqual({
        query: "needle",
        current: 1,
        total: 1,
        pending: false,
      });

      await vi.advanceTimersByTimeAsync(16);
      expect(search).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
