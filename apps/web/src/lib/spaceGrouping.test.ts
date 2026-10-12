import { SpaceId } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import type { Space } from "~/types";
import { activeSpaceDisplayNameForReference, resolveActiveSpaceId } from "./spaceGrouping";

const workSpaceId = SpaceId.makeUnsafe("space-work");
const workSpace: Space = {
  id: workSpaceId,
  name: "Work",
  icon: "bag",
  sortOrder: 0,
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
};

describe("resolveActiveSpaceId", () => {
  it("keeps known selections and exposes missing persisted ids as missing", () => {
    expect(resolveActiveSpaceId(workSpaceId, [workSpace])).toBe(workSpaceId);
    expect(resolveActiveSpaceId(SpaceId.makeUnsafe("space-deleted"), [workSpace])).toBeNull();
    expect(resolveActiveSpaceId(null, [workSpace])).toBeNull();
  });
});

describe("activeSpaceDisplayNameForReference", () => {
  it("names active and archived references without retaining archive rows", () => {
    expect(activeSpaceDisplayNameForReference(workSpaceId, [workSpace])).toBe("Work");
    expect(activeSpaceDisplayNameForReference(workSpaceId, [], "Work")).toBe("Work");
    expect(activeSpaceDisplayNameForReference(SpaceId.makeUnsafe("space-missing"), [])).toBe(
      "Archived space",
    );
  });
});
