import { describe, expect, it } from "vitest";

import {
  diffAppPermissionDeclarations,
  isPenkraPermissionName,
  permissionsRequiringUpdateReview,
} from "./permissions";

describe("App permission declarations", () => {

  it("requires review when an identity audience changes", () => {
    const before = [
      {
        name: "account-identity",
        required: true,
        reason: "Sign in",
        audience: "api.borge.ai",
      },
    ];
    const after = [{ ...before[0]!, audience: "api.example.com" }];
    expect(diffAppPermissionDeclarations(before, after).map((change) => change.kind)).toEqual([
      "audience-changed",
    ]);
    expect(permissionsRequiringUpdateReview(before, after)).toEqual(["account-identity"]);
  });

  it("distinguishes authority expansion from reductions and explanatory changes", () => {
    const before = [
      { name: "network-fetch", required: false, reason: "Sync designs" },
      { name: "browser-session", required: true, reason: "Render hosted pages" },
    ];
    const after = [
      { name: "network-fetch", required: true, reason: "Sync designs and comments" },
      { name: "simulator-session", required: false, reason: "Run simulated devices" },
    ];
    expect(diffAppPermissionDeclarations(before, after).map((change) => change.kind)).toEqual([
      "requirement-changed",
      "reason-changed",
      "added",
      "removed",
    ]);
    expect(permissionsRequiringUpdateReview(before, after)).toEqual([
      "network-fetch",
      "simulator-session",
    ]);
  });
});
