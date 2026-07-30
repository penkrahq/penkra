// FILE: accountWebsiteOrigin.ts
// Purpose: Validates the public website origin used for desktop account-authentication UI.
// Layer: Desktop shared policy

const DEFAULT_PENKRA_WEBSITE_ORIGIN = "https://penkra.com";

export function resolvePenkraWebsiteOrigin(configuredOrigin?: string): string {
  const candidate = configuredOrigin?.trim() || DEFAULT_PENKRA_WEBSITE_ORIGIN;
  const url = new URL(candidate);
  const isLocalHttp =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("PENKRA_WEBSITE_ORIGIN must use HTTPS, except for localhost development.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
