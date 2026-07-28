import { describe, expect, it, vi } from "vitest";
import { createVirtualTextFindSurface } from "./virtualTextFindSurface";

describe("createVirtualTextFindSurface", () => {
  it("counts the full model and reveals the exact row occurrence", async () => {
    const reveal = vi.fn();
    const highlight = vi.fn();
    const surface = createVirtualTextFindSurface({
      id: "timeline",
      order: 0,
      isVisible: () => true,
      getEntries: () => [
        { id: "offscreen-1", index: 0, text: "needle then needle" },
        { id: "offscreen-2", index: 50, text: "final needle" },
      ],
      reveal,
      highlight,
      clearHighlight: vi.fn(),
    });

    expect(await surface.search("needle", 1)).toEqual({ count: 3 });
    await surface.activate(2);
    expect(reveal).toHaveBeenCalledWith(
      {
        id: "offscreen-2",
        index: 50,
        text: "final needle",
      },
      "needle",
      0,
    );
    expect(highlight).toHaveBeenCalledWith(
      { id: "offscreen-2", index: 50, text: "final needle" },
      "needle",
      0,
    );
  });
});
