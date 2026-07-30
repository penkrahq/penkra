// FILE: accountAuthCallback.ts
// Purpose: Recognizes only Penkra account-auth return URLs before Electron processes them.
// Layer: Desktop main-process helper

import { PENKRA_ACCOUNT_AUTH_SCHEME } from "@synara/shared/desktopIdentity";

export const PENKRA_ACCOUNT_AUTH_CALLBACK_PATH = "/auth/callback";

export function isPenkraAccountAuthCallbackUrl(
  value: string,
  expectedScheme = PENKRA_ACCOUNT_AUTH_SCHEME,
): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === `${expectedScheme}:` &&
      url.hostname === "auth" &&
      url.pathname === "/callback" &&
      url.hash.startsWith("#token=")
    );
  } catch {
    return false;
  }
}
