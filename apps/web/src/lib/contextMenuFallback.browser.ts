import "../index.css";

import { afterEach, describe, expect, it } from "vitest";

import { showContextMenuFallback } from "../contextMenuFallback";

describe("browser context menu fallback", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps disabled actions visible while skipping them for pointer and keyboard activation", async () => {
    let settled = false;
    const result = showContextMenuFallback([
      { id: "rename", label: "Rename" },
      { id: "leave-deck", label: "Leave Deck", enabled: false },
      { id: "archive", label: "Archive" },
    ]).then((selection) => {
      settled = true;
      return selection;
    });
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));

    expect(buttons.map((button) => button.textContent)).toEqual([
      "Rename",
      "Leave Deck",
      "Archive",
    ]);
    expect(buttons[1]?.disabled).toBe(true);
    buttons[1]?.click();
    await Promise.resolve();
    expect(settled).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(document.activeElement).toBe(buttons[0]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    expect(document.activeElement).toBe(buttons[2]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await expect(result).resolves.toBe("archive");
  });
});
