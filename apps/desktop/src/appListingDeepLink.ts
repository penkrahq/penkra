// FILE: appListingDeepLink.ts
// Purpose: Parses canonical registry listing links without accepting navigation ambiguity.
// Layer: Desktop protocol boundary

const APP_ID = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,}$/;

export function parseAppListingDeepLink(value: string): { appId: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "penkra:" ||
    url.hostname !== "apps" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return null;
  let appId: string;
  try {
    appId = decodeURIComponent(segments[0]!);
  } catch {
    return null;
  }
  return APP_ID.test(appId) ? { appId } : null;
}
