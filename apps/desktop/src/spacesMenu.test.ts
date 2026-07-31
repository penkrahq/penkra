import { describe, expect, it } from "vitest";

import { normalizeDesktopSpacesMenuInput } from "./spacesMenu";

describe("normalizeDesktopSpacesMenuInput", () => {
  it("preserves ordered Spaces and the active marker", () => {
    expect(
      normalizeDesktopSpacesMenuInput({
        activeSpaceId: "work",
        spaces: [
          { id: "personal", name: "Personal" },
          { id: "work", name: "Work" },
        ],
      }),
    ).toEqual({
      activeSpaceId: "work",
      spaces: [
        { id: "personal", name: "Personal" },
        { id: "work", name: "Work" },
      ],
    });
  });

  it("rejects malformed roots and sanitizes renderer-owned rows", () => {
    expect(normalizeDesktopSpacesMenuInput(null)).toBeNull();
    expect(normalizeDesktopSpacesMenuInput({ spaces: "nope" })).toBeNull();
    expect(
      normalizeDesktopSpacesMenuInput({
        activeSpaceId: "missing",
        spaces: [
          { id: " work ", name: " Work " },
          { id: "work", name: "Duplicate" },
          { id: "", name: "Missing id" },
          null,
        ],
      }),
    ).toEqual({ activeSpaceId: null, spaces: [{ id: "work", name: "Work" }] });
  });
});
