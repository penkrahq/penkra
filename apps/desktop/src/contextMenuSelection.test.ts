import { describe, expect, it, vi } from "vitest";

import { createContextMenuSelection } from "./contextMenuSelection";

describe("createContextMenuSelection", () => {
  it("keeps a click dispatched after the popup close callback", async () => {
    const scheduled: Array<() => void> = [];
    const selection = createContextMenuSelection<string>((callback) => scheduled.push(callback));

    selection.dismiss();
    selection.select("archive");
    scheduled.forEach((callback) => callback());

    await expect(selection.result).resolves.toBe("archive");
  });

  it("returns null for a genuine dismissal", async () => {
    const scheduled: Array<() => void> = [];
    const selection = createContextMenuSelection<string>((callback) => scheduled.push(callback));

    selection.dismiss();
    scheduled[0]?.();

    await expect(selection.result).resolves.toBeNull();
  });

  it("settles only once when close follows a normal click", async () => {
    const schedule = vi.fn<(callback: () => void) => void>((callback) => callback());
    const selection = createContextMenuSelection<string>(schedule);

    selection.select("rename");
    selection.dismiss();

    await expect(selection.result).resolves.toBe("rename");
  });
});
