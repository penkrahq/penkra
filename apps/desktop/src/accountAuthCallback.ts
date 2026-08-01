// FILE: accountAuthCallback.ts
// Purpose: Recognizes only Penkra account-auth return URLs before Electron processes them.
// Layer: Desktop main-process helper

import { PENKRA_ACCOUNT_AUTH_SCHEME } from "@penkra/shared/desktopIdentity";

export const PENKRA_ACCOUNT_AUTH_CALLBACK_PATH = "/auth/callback";

export function isPenkraAccountAuthCallbackUrl(
  value: string,
  expectedScheme = PENKRA_ACCOUNT_AUTH_SCHEME,
): boolean {
  return readPenkraAccountAuthCallbackToken(value, expectedScheme) !== null;
}

export function readPenkraAccountAuthCallbackToken(
  value: string,
  expectedScheme = PENKRA_ACCOUNT_AUTH_SCHEME,
): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol === `${expectedScheme}:` &&
      url.hostname === "auth" &&
      url.pathname === "/callback" &&
      url.hash.startsWith("#token=")
    ) {
      // Better Auth decodes the token during authenticate(); preserve the raw
      // fragment here so percent escapes are not decoded twice.
      const token = url.hash.slice("#token=".length).trim();
      return token || null;
    }
    return null;
  } catch {
    return null;
  }
}
