// FILE: desktopIdentity.ts
// Purpose: Defines the canonical desktop application identity across packaging and runtime.

export const LEGACY_SYNARA_DESKTOP_SCHEME = "synara";
export const SYNARA_DESKTOP_SCHEME = "penkra";
export const SYNARA_DESKTOP_ORIGIN = `${SYNARA_DESKTOP_SCHEME}://app`;
export const SYNARA_DESKTOP_ENTRY_URL = `${SYNARA_DESKTOP_ORIGIN}/index.html`;
export const PENKRA_PRODUCTION_ACCOUNT_AUTH_SCHEME = "com.penkra.app";
export const PENKRA_DEVELOPMENT_ACCOUNT_AUTH_SCHEME = `${PENKRA_PRODUCTION_ACCOUNT_AUTH_SCHEME}.dev`;
export const PENKRA_ACCOUNT_AUTH_SCHEME = PENKRA_PRODUCTION_ACCOUNT_AUTH_SCHEME;
export const SYNARA_DESKTOP_UPDATE_CHANNEL = "latest";
export const SYNARA_PRODUCTION_BUNDLE_ID = "com.penkra.app";
export const SYNARA_DEVELOPMENT_BUNDLE_ID = `${SYNARA_PRODUCTION_BUNDLE_ID}.dev`;

export type SynaraDesktopFlavor = "production" | "development";

export interface SynaraDesktopIdentity {
  readonly flavor: SynaraDesktopFlavor;
  readonly displayName: string;
  readonly bundleId: string;
  readonly accountAuthScheme: string;
  readonly scheme: string;
  readonly origin: string;
  readonly entryUrl: string;
  readonly userDataDirectoryName: string;
  readonly defaultHomeDirectoryName: string;
}

export function resolveSynaraDesktopFlavor(input: {
  readonly isDevelopment: boolean;
}): SynaraDesktopFlavor {
  return input.isDevelopment ? "development" : "production";
}

export function synaraDesktopIdentity(flavor: SynaraDesktopFlavor): SynaraDesktopIdentity {
  if (flavor === "development") {
    return {
      flavor,
      displayName: "Penkra (Dev)",
      bundleId: SYNARA_DEVELOPMENT_BUNDLE_ID,
      accountAuthScheme: PENKRA_DEVELOPMENT_ACCOUNT_AUTH_SCHEME,
      scheme: SYNARA_DESKTOP_SCHEME,
      origin: SYNARA_DESKTOP_ORIGIN,
      entryUrl: SYNARA_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "penkra-dev",
      defaultHomeDirectoryName: ".penkra",
    };
  }
  return {
    flavor,
    displayName: "Penkra",
    bundleId: SYNARA_PRODUCTION_BUNDLE_ID,
    accountAuthScheme: PENKRA_PRODUCTION_ACCOUNT_AUTH_SCHEME,
    scheme: SYNARA_DESKTOP_SCHEME,
    origin: SYNARA_DESKTOP_ORIGIN,
    entryUrl: SYNARA_DESKTOP_ENTRY_URL,
    userDataDirectoryName: "penkra",
    defaultHomeDirectoryName: ".penkra",
  };
}

export function synaraBundleId(isDevelopment: boolean): string {
  return synaraDesktopIdentity(isDevelopment ? "development" : "production").bundleId;
}
