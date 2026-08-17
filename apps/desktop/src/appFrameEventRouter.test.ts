import { describe, expect, it, vi } from "vitest";

import { AppFrameEventRouter } from "./appFrameEventRouter";

describe("AppFrameEventRouter", () => {
  it("replays events that arrive before the Runtime v2 listener is registered", () => {
    const router = new AppFrameEventRouter();
    const listener = vi.fn();

    router.deliver("account.subscription.subscription-1", {
      kind: "connection-state",
      state: "connected",
    });
    router.add("account.subscription.subscription-1", listener);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      kind: "connection-state",
      state: "connected",
    });
  });

  it("delivers buffered events once and then switches to live delivery", () => {
    const router = new AppFrameEventRouter();
    const listener = vi.fn();

    router.deliver("channel", "before");
    const remove = router.add("channel", listener);
    router.deliver("channel", "after");
    remove();
    router.deliver("channel", "next listener");
    router.add("channel", listener);

    expect(listener.mock.calls).toEqual([["before"], ["after"], ["next listener"]]);
  });

  it("bounds a channel backlog while no listener exists", () => {
    const router = new AppFrameEventRouter();
    const listener = vi.fn();

    for (let index = 0; index < 20; index += 1) router.deliver("channel", index);
    router.add("channel", listener);

    expect(listener).toHaveBeenCalledTimes(16);
    expect(listener.mock.calls[0]).toEqual([4]);
    expect(listener.mock.calls.at(-1)).toEqual([19]);
  });
});
