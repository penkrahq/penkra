// FILE: appDistributionPolicy.ts
// Purpose: Declares registry identities and lifecycle policy for Penkra's default Apps.
// Layer: Desktop App policy

import { REQUIRED_APPS_APP_ID } from "@penkra/shared/requiredAppsRelease";

export { REQUIRED_APPS_APP_ID } from "@penkra/shared/requiredAppsRelease";
export const BROWSER_APP_ID = "com.penkra.browser";

// Required Apps is preinstalled from the desktop's pinned embedded registry package.
// These optional defaults remain ordinary remote registry bootstrap candidates.
export const DEFAULT_REGISTRY_APPS = [
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
