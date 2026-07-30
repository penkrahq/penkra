// FILE: accountAuthOrigin.ts
// Purpose: Validates the public web origin used by desktop account authentication.
// Layer: Desktop shared policy

const DEFAULT_PENKRA_AUTH_ORIGIN = "https://penkra.com";

export function resolvePenkraAuthOrigin(configuredOrigin?: string): string {
  const candidate = configuredOrigin?.trim() || DEFAULT_PENKRA_AUTH_ORIGIN;
  const url = new URL(candidate);
  const isLocalHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("PENKRA_AUTH_ORIGIN must use HTTPS, except for localhost development.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
