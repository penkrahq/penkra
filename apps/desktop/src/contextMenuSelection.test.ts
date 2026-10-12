import { describe, expect, it } from "vitest";

import { createContextMenuSelection } from "./contextMenuSelection";

describe("createContextMenuSelection", () => {
  it("keeps the click dispatched before the popup close callback", async () => {
    const selection = createContextMenuSelection<string>();

    selection.select("archive");
    selection.dismiss();

    await expect(selection.result).resolves.toBe("archive");
  });

  it("returns null for a genuine dismissal", async () => {
    const selection = createContextMenuSelection<string>();

    selection.dismiss();

    await expect(selection.result).resolves.toBeNull();
  });

  it("settles only once when close follows a normal click", async () => {
    const selection = createContextMenuSelection<string>();

    selection.select("rename");
    selection.select("archive");
    selection.dismiss();

    await expect(selection.result).resolves.toBe("rename");
  });
  it("does not replace a settled dismissal with a later selection", async () => {
    const selection = createContextMenuSelection<string>();
    selection.dismiss();
    selection.select("archive");
    await expect(selection.result).resolves.toBeNull();
  });
});
