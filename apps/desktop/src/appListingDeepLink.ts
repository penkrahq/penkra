// FILE: appListingDeepLink.ts
// Purpose: Parses canonical registry listing links without accepting navigation ambiguity.
// Layer: Desktop protocol boundary

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  return UUID.test(appId) ? { appId: appId.toLowerCase() } : null;
}
