import { describe, expect, it, vi } from "vitest";

import { createBufferedPreloadEvent } from "./bufferedPreloadEvent";

describe("buffered preload event", () => {
  it("replays startup events to the first listener and then delivers live events once", () => {
    const event = createBufferedPreloadEvent<string>();
    const listener = vi.fn();

    event.publish("before-shell");
    const unsubscribe = event.subscribe(listener);
    event.publish("after-shell");
    unsubscribe();

    expect(listener.mock.calls).toEqual([["before-shell"], ["after-shell"]]);
  });

  it("buffers events again while the shell surface is remounting", () => {
    const event = createBufferedPreloadEvent<string>();
    const first = vi.fn();
    const removeFirst = event.subscribe(first);
    event.publish("first-surface");
    removeFirst();
    event.publish("between-surfaces");

    const second = vi.fn();
    event.subscribe(second);

    expect(first).toHaveBeenCalledWith("first-surface");
    expect(second).toHaveBeenCalledWith("between-surfaces");
  });

  it("keeps only the configured number of startup events", () => {
    const event = createBufferedPreloadEvent<number>(2);
    event.publish(1);
    event.publish(2);
    event.publish(3);
    const listener = vi.fn();

    event.subscribe(listener);

    expect(listener.mock.calls).toEqual([[2], [3]]);
  });
});
