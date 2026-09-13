import { describe, expect, it } from "vitest";

import { normalizeAppContextMenuItems } from "./appContextMenu";

describe("normalizeAppContextMenuItems", () => {
  it("preserves recursively declared native menu behavior", () => {
    expect(
      normalizeAppContextMenuItems([
        { id: "open", label: "Open" },
        {
          type: "submenu",
          label: "Move to",
          separatorBefore: true,
          items: [
            { id: "move-root", label: "All Designs", enabled: false },
            { type: "separator" },
            {
              type: "submenu",
              label: "Clients",
              items: [{ id: "move-schoolbase", label: "SchoolBase" }],
            },
          ],
        },
        { id: "trash", label: "Move to Trash", destructive: true },
      ]),
    ).toEqual([
      {
        type: "action",
        id: "open",
        label: "Open",
        enabled: true,
        checked: undefined,
        accelerator: undefined,
        destructive: false,
      },
      { type: "separator" },
      {
        type: "submenu",
        label: "Move to",
        enabled: true,
        items: [
          {
            type: "action",
            id: "move-root",
            label: "All Designs",
            enabled: false,
            checked: undefined,
            accelerator: undefined,
            destructive: false,
          },
          { type: "separator" },
          {
            type: "submenu",
            label: "Clients",
            enabled: true,
            items: [
              {
                type: "action",
                id: "move-schoolbase",
                label: "SchoolBase",
                enabled: true,
                checked: undefined,
                accelerator: undefined,
                destructive: false,
              },
            ],
          },
        ],
      },
      {
        type: "action",
        id: "trash",
        label: "Move to Trash",
        enabled: true,
        checked: undefined,
        accelerator: undefined,
        destructive: true,
      },
    ]);
  });

  it("rejects ambiguous and malformed declarations", () => {
    expect(() =>
      normalizeAppContextMenuItems([
        { id: "same", label: "First" },
        { type: "submenu", label: "More", items: [{ id: "same", label: "Second" }] },
      ]),
    ).toThrow("unique");
    expect(() =>
      normalizeAppContextMenuItems([{ type: "submenu", label: "More", items: "not-an-array" }]),
    ).toThrow("items array");
  });
});
