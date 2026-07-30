import { resolvePenkraWebsiteOrigin } from "./accountWebsiteOrigin";

export const PENKRA_PRODUCTION_API_URL = "https://api.penkra.com";

export type PenkraAccountServiceEndpoints = {
  readonly apiUrl: string;
  readonly authBaseUrl: string;
  readonly websiteOrigin: string;
};

export function resolvePenkraAccountServiceEndpoints(input: {
  readonly configuredApiUrl?: string | undefined;
  readonly configuredWebsiteOrigin?: string | undefined;
}): PenkraAccountServiceEndpoints {
  const configuredApiUrl = input.configuredApiUrl?.trim();
  const configuredWebsiteOrigin = input.configuredWebsiteOrigin?.trim();
  if (Boolean(configuredApiUrl) !== Boolean(configuredWebsiteOrigin)) {
    throw new Error("PENKRA_API_URL and PENKRA_WEBSITE_ORIGIN must be configured together.");
  }
  const apiUrl = resolveApiUrl(configuredApiUrl);
  return {
    apiUrl,
    authBaseUrl: `${apiUrl}/auth`,
    websiteOrigin: resolvePenkraWebsiteOrigin(configuredWebsiteOrigin),
  };
}

function resolveApiUrl(configuredApiUrl?: string): string {
  const url = new URL(configuredApiUrl || PENKRA_PRODUCTION_API_URL);
  const isLocalHttp =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("PENKRA_API_URL must use HTTPS, except for localhost development.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
