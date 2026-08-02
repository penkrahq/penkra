import { describe, expect, it } from "vitest";

import { diffAppPermissionDeclarations, permissionsRequiringUpdateReview } from "./permissions";

describe("App permission declarations", () => {
  it("distinguishes authority expansion from reductions and explanatory changes", () => {
    const before = [
      { name: "network-fetch", required: false, reason: "Sync designs" },
      { name: "raw-socket", required: true, reason: "Connect to a local daemon" },
    ];
    const after = [
      { name: "network-fetch", required: true, reason: "Sync designs and comments" },
      { name: "process-spawn", required: false, reason: "Run the selected formatter" },
    ];
    expect(diffAppPermissionDeclarations(before, after).map((change) => change.kind)).toEqual([
      "requirement-changed",
      "reason-changed",
      "added",
      "removed",
    ]);
    expect(permissionsRequiringUpdateReview(before, after)).toEqual(["network-fetch", "process-spawn"]);
  });
});
