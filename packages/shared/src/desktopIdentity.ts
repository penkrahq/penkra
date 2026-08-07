// FILE: desktopIdentity.ts
// Purpose: Defines the canonical desktop application identity across packaging and runtime.

export const LEGACY_PENKRA_DESKTOP_SCHEME = "penkra";
export const PENKRA_DESKTOP_SCHEME = "penkra";
export const PENKRA_DESKTOP_ORIGIN = `${PENKRA_DESKTOP_SCHEME}://app`;
export const PENKRA_DESKTOP_ENTRY_URL = `${PENKRA_DESKTOP_ORIGIN}/index.html`;
export const PENKRA_PRODUCTION_ACCOUNT_AUTH_SCHEME = "com.penkra.app";
export const PENKRA_DEVELOPMENT_ACCOUNT_AUTH_SCHEME = `${PENKRA_PRODUCTION_ACCOUNT_AUTH_SCHEME}.dev`;
export const PENKRA_ACCOUNT_AUTH_SCHEME = PENKRA_PRODUCTION_ACCOUNT_AUTH_SCHEME;
export const PENKRA_DESKTOP_UPDATE_CHANNEL = "latest";
export const PENKRA_PRODUCTION_BUNDLE_ID = "com.penkra.app";
export const PENKRA_DEVELOPMENT_BUNDLE_ID = `${PENKRA_PRODUCTION_BUNDLE_ID}.dev`;

export type PenkraDesktopFlavor = "production" | "development";

export interface PenkraDesktopIdentity {
  readonly flavor: PenkraDesktopFlavor;
  readonly displayName: string;
  readonly bundleId: string;
  readonly accountAuthScheme: string;
  readonly scheme: string;
  readonly origin: string;
  readonly entryUrl: string;
  readonly userDataDirectoryName: string;
  readonly defaultHomeDirectoryName: string;
}

export const DEFAULT_PENKRA_DEV_INSTANCE = 1;

export function resolvePenkraDevInstance(value?: string): number {
  const configured = value?.trim();
  if (!configured) return DEFAULT_PENKRA_DEV_INSTANCE;
  if (!/^[1-9]\d*$/u.test(configured)) {
    throw new Error(`Invalid Penkra Dev instance: ${value}. Expected a positive integer.`);
  }
  const instance = Number(configured);
  if (!Number.isSafeInteger(instance)) {
    throw new Error(`Invalid Penkra Dev instance: ${value}. Expected a safe positive integer.`);
  }
  return instance;
}

export function penkraDevDisplayName(instance: number): string {
  return instance === DEFAULT_PENKRA_DEV_INSTANCE ? "Penkra Dev" : `Penkra Dev ${instance}`;
}

export function penkraDevBundleId(instance: number): string {
  return instance === DEFAULT_PENKRA_DEV_INSTANCE
    ? PENKRA_DEVELOPMENT_BUNDLE_ID
    : `${PENKRA_DEVELOPMENT_BUNDLE_ID}.${instance}`;
}

export function resolvePenkraDesktopFlavor(input: {
  readonly isPackaged: boolean;
  readonly requestedFlavor?: string;
}): PenkraDesktopFlavor {
  const requestedFlavor = input.requestedFlavor?.trim();

  if (requestedFlavor === "development") {
    return "development";
  }

  if (requestedFlavor) {
    throw new Error(`Unsupported Penkra desktop flavor: ${requestedFlavor}.`);
  }

  if (input.isPackaged) {
    return "production";
  }

  throw new Error(
    "A local Penkra desktop runtime must explicitly set PENKRA_DESKTOP_FLAVOR=development.",
  );
}

export function penkraDesktopIdentity(
  flavor: PenkraDesktopFlavor,
  developmentInstance = DEFAULT_PENKRA_DEV_INSTANCE,
): PenkraDesktopIdentity {
  if (flavor === "development") {
    const displayName = penkraDevDisplayName(developmentInstance);
    const bundleId = penkraDevBundleId(developmentInstance);
    return {
      flavor,
      displayName,
      bundleId,
      accountAuthScheme:
        developmentInstance === DEFAULT_PENKRA_DEV_INSTANCE
          ? PENKRA_DEVELOPMENT_ACCOUNT_AUTH_SCHEME
          : `${PENKRA_DEVELOPMENT_ACCOUNT_AUTH_SCHEME}.${developmentInstance}`,
      scheme: PENKRA_DESKTOP_SCHEME,
      origin: PENKRA_DESKTOP_ORIGIN,
      entryUrl: PENKRA_DESKTOP_ENTRY_URL,
      userDataDirectoryName:
        developmentInstance === DEFAULT_PENKRA_DEV_INSTANCE
          ? "penkra-dev"
          : `penkra-dev-${developmentInstance}`,
      defaultHomeDirectoryName: ".penkra",
    };
  }
  return {
    flavor,
    displayName: "Penkra",
    bundleId: PENKRA_PRODUCTION_BUNDLE_ID,
    accountAuthScheme: PENKRA_PRODUCTION_ACCOUNT_AUTH_SCHEME,
    scheme: PENKRA_DESKTOP_SCHEME,
    origin: PENKRA_DESKTOP_ORIGIN,
    entryUrl: PENKRA_DESKTOP_ENTRY_URL,
    userDataDirectoryName: "penkra",
    defaultHomeDirectoryName: ".penkra",
  };
}

export function penkraBundleId(isDevelopment: boolean): string {
  return penkraDesktopIdentity(isDevelopment ? "development" : "production").bundleId;
}
