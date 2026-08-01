// FILE: desktopProtocolSchemes.ts
// Purpose: Defines the one privileged-scheme registration owned by the desktop bootstrap.
// Layer: Desktop main-process helper

import type { PenkraDesktopIdentity } from "@penkra/shared/desktopIdentity";

export interface DesktopPrivilegedScheme {
  readonly scheme: string;
  readonly privileges: {
    readonly standard: boolean;
    readonly secure: boolean;
    readonly supportFetchAPI?: boolean;
    readonly corsEnabled?: boolean;
  };
}

// Electron permits registerSchemesAsPrivileged() only once. Account auth must use
// Penkra's registration and callback handling instead of registering independently.
export const BETTER_AUTH_PROTOCOL_REGISTRATION_ENABLED = false;

export function createDesktopPrivilegedSchemes(
  identity: Pick<PenkraDesktopIdentity, "accountAuthScheme" | "scheme">,
): ReadonlyArray<DesktopPrivilegedScheme> {
  return [
    {
      scheme: identity.scheme,
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
  ];
}
