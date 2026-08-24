import type { DesktopAccountAuthState } from "@penkra/contracts";
import { describe, expect, it } from "vitest";

import { resolveDesktopAccountName } from "./useDesktopAccountAuthState";

describe("resolveDesktopAccountName", () => {
  it("uses the authenticated account name", () => {
    const state: DesktopAccountAuthState = {
      status: "authenticated",
      user: {
        id: "user-1",
        email: "email-fallback@example.com",
        name: "  Account Name  ",
        image: null,
      },
    };

    expect(resolveDesktopAccountName(state)).toBe("Account Name");
  });

  it("does not fall back to the email when the account name is blank", () => {
    const state: DesktopAccountAuthState = {
      status: "authenticated",
      user: {
        id: "user-1",
        email: "email-fallback@example.com",
        name: "   ",
        image: null,
      },
    };

    expect(resolveDesktopAccountName(state)).toBe("");
  });

  it("has no name before authentication", () => {
    expect(resolveDesktopAccountName(null)).toBe("");
    expect(resolveDesktopAccountName({ status: "unauthenticated" })).toBe("");
  });
});
