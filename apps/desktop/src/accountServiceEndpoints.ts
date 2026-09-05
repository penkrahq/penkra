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
  const apiUrl = resolveApiUrl(configuredApiUrl);
  // Earlier desktops exported the resolved production API alone. AppImage updates
  // and app.relaunch inherit that environment. A redundant production API is not
  // a custom environment override; custom endpoints must still be supplied together.
  const inheritedProductionDefault =
    configuredApiUrl && !configuredWebsiteOrigin && apiUrl === PENKRA_PRODUCTION_API_URL;
  if (
    Boolean(configuredApiUrl) !== Boolean(configuredWebsiteOrigin) &&
    !inheritedProductionDefault
  ) {
    throw new Error("PENKRA_API_URL and PENKRA_WEBSITE_ORIGIN must be configured together.");
  }
  return {
    apiUrl,
    authBaseUrl: `${apiUrl}/auth`,
    websiteOrigin: resolvePenkraWebsiteOrigin(configuredWebsiteOrigin),
  };
}

export function initializePenkraAccountServiceEnvironment(
  env: NodeJS.ProcessEnv,
): PenkraAccountServiceEndpoints {
  const endpoints = resolvePenkraAccountServiceEndpoints({
    configuredApiUrl: env.PENKRA_API_URL,
    configuredWebsiteOrigin: env.PENKRA_WEBSITE_ORIGIN,
  });
  env.PENKRA_API_URL = endpoints.apiUrl;
  env.PENKRA_WEBSITE_ORIGIN = endpoints.websiteOrigin;
  return endpoints;
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
