import { afterEach, describe, expect, it, vi } from "vitest";

import { watchDevelopmentAppSideload } from "./developmentAppSideloadWatcher";

afterEach(() => vi.useRealTimers());

function fixture(reload = vi.fn(async () => undefined)) {
  let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  let errorListener: ((error: Error) => void) | undefined;
  const close = vi.fn();
  const onError = vi.fn();
  const watcher = watchDevelopmentAppSideload({
    sourcePath: "/work/canvas/dist",
    reload,
    onError,
    debounceMs: 100,
    watchDirectory: vi.fn((_path, _options, nextListener) => {
      listener = nextListener;
      return {
        close,
        on: vi.fn((_event, nextErrorListener) => {
          errorListener = nextErrorListener;
        }),
      };
    }),
  });
  return {
    close,
    error: (error: Error) => errorListener?.(error),
    event: (filename: string | null) => listener?.("change", filename),
    onError,
    reload,
    watcher,
  };
}

describe("development App sideload watcher", () => {
  it("coalesces dist rebuild events and ignores sibling paths", async () => {
    vi.useFakeTimers();
    const test = fixture();
    test.event("src/app.ts");
    test.event("dist/app.js");
    test.event("dist/styles.css");

    await vi.advanceTimersByTimeAsync(99);
    expect(test.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.reload).toHaveBeenCalledOnce();
    await test.watcher.close();
  });

  it("queues one follow-up reload when a rebuild lands during a swap", async () => {
    vi.useFakeTimers();
    let finishFirst: (() => void) | undefined;
    const reload = vi
      .fn<() => Promise<undefined>>()
      .mockImplementationOnce(
        () => new Promise((resolve) => (finishFirst = () => resolve(undefined))),
      )
      .mockResolvedValue(undefined);
    const test = fixture(reload);
    test.event("dist/app.js");
    await vi.advanceTimersByTimeAsync(100);
    test.event("dist/styles.css");
    await vi.advanceTimersByTimeAsync(100);
    expect(reload).toHaveBeenCalledOnce();

    finishFirst?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(reload).toHaveBeenCalledTimes(2);
    await test.watcher.close();
  });

  it("keeps the working watcher alive after a failed reload and closes cleanly", async () => {
    vi.useFakeTimers();
    const reload = vi
      .fn<() => Promise<undefined>>()
      .mockRejectedValueOnce(new Error("invalid bundle"))
      .mockResolvedValue(undefined);
    const test = fixture(reload);
    test.event("dist/app.js");
    await vi.advanceTimersByTimeAsync(100);
    expect(test.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "invalid bundle" }),
    );

    test.event("dist/app.js");
    await vi.advanceTimersByTimeAsync(100);
    expect(reload).toHaveBeenCalledTimes(2);
    await test.watcher.close();
    expect(test.close).toHaveBeenCalledOnce();

    test.event("dist/app.js");
    await vi.advanceTimersByTimeAsync(100);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
