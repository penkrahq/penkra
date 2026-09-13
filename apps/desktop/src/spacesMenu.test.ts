import { describe, expect, it } from "vitest";

import {
  normalizeDesktopSpacesMenuInput,
  shouldPromoteDesktopSpacesMenuState,
} from "./spacesMenu";

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

describe("shouldPromoteDesktopSpacesMenuState", () => {
  it("accepts the first renderer state even when another application owns focus", () => {
    expect(
      shouldPromoteDesktopSpacesMenuState({
        senderFocused: false,
        shellWindowExists: true,
        currentSpaceCount: 0,
      }),
    ).toBe(true);
  });

  it("preserves a populated state until its shell is focused", () => {
    expect(
      shouldPromoteDesktopSpacesMenuState({
        senderFocused: false,
        shellWindowExists: true,
        currentSpaceCount: 2,
      }),
    ).toBe(false);
    expect(
      shouldPromoteDesktopSpacesMenuState({
        senderFocused: true,
        shellWindowExists: true,
        currentSpaceCount: 2,
      }),
    ).toBe(true);
  });
});
