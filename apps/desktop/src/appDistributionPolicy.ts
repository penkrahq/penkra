// FILE: appDistributionPolicy.ts
// Purpose: Declares registry identities and lifecycle policy for Penkra's default Apps.
// Layer: Desktop App policy

export const REQUIRED_APPS_APP_ID = "com.penkra.apps";
export const BROWSER_APP_ID = "com.penkra.browser";

export const DEFAULT_REGISTRY_APPS = [
  { appId: REQUIRED_APPS_APP_ID, slug: "apps", permissions: {} },
  { appId: "com.penkra.explorer", slug: "explorer", permissions: {} },
  {
    appId: BROWSER_APP_ID,
    slug: "browser",
    permissions: { "browser-session": "granted" as const },
  },
] as const;

export function isRequiredApp(appId: string): boolean {
  return appId === REQUIRED_APPS_APP_ID;
}
