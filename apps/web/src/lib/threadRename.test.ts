import { describe, expect, it, vi } from "vitest";

const updateThread = vi.fn();
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    cleanCore: { updateThread },
  }),
}));

import { dispatchThreadRename } from "./threadRename";

describe("dispatchThreadRename", () => {
  it("updates existing server threads", async () => {
    updateThread.mockReset().mockResolvedValue(undefined);
    const outcome = await dispatchThreadRename({
      threadId: "thread-server" as never,
      newTitle: "Renamed server thread",
      unchangedTitles: ["New thread"],
    });

    expect(outcome).toBe("renamed");
    expect(updateThread).toHaveBeenCalledTimes(1);
    expect(updateThread.mock.calls[0]?.[0]).toMatchObject({
      update: {
        action: "rename",
        threadId: "thread-server",
        title: "Renamed server thread",
      },
    });
  });
});
