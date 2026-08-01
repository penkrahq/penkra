// FILE: desktopProtocolSchemes.test.ts
// Purpose: Guards the single secure-scheme registration required by packaged renderers.

import { describe, expect, it } from "vitest";

import { penkraDesktopIdentity } from "@penkra/shared/desktopIdentity";
import {
  BETTER_AUTH_PROTOCOL_REGISTRATION_ENABLED,
  createDesktopPrivilegedSchemes,
} from "./desktopProtocolSchemes";

describe("desktop privileged schemes", () => {
  it.each(["production", "development"] as const)(
    "registers the content and auth schemes together for %s",
    (flavor) => {
      const identity = penkraDesktopIdentity(flavor);

      expect(createDesktopPrivilegedSchemes(identity)).toEqual([
        {
          scheme: "penkra",
          privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
          },
        },
        {
          scheme: identity.accountAuthScheme,
          privileges: {
            standard: false,
            secure: true,
          },
        },
      ]);
    },
  );

  it("prevents Better Auth from replacing the desktop secure-scheme list", () => {
    expect(BETTER_AUTH_PROTOCOL_REGISTRATION_ENABLED).toBe(false);
  });
});
