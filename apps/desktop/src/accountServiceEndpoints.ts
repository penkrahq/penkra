import { resolvePenkraAuthOrigin } from "./accountAuthOrigin";

export const PENKRA_PRODUCTION_API_URL = "https://api.penkra.com";

export type PenkraAccountServiceEndpoints = {
  readonly apiUrl: string;
  readonly authOrigin: string;
};

export function resolvePenkraAccountServiceEndpoints(input: {
  readonly configuredApiUrl?: string | undefined;
  readonly configuredAuthOrigin?: string | undefined;
}): PenkraAccountServiceEndpoints {
  const configuredApiUrl = input.configuredApiUrl?.trim();
  const configuredAuthOrigin = input.configuredAuthOrigin?.trim();
  if (Boolean(configuredApiUrl) !== Boolean(configuredAuthOrigin)) {
    throw new Error(
      "PENKRA_API_URL and PENKRA_AUTH_ORIGIN must be configured together.",
    );
  }
  return {
    apiUrl: resolveApiUrl(configuredApiUrl),
    authOrigin: resolvePenkraAuthOrigin(configuredAuthOrigin),
  };
}

function resolveApiUrl(configuredApiUrl?: string): string {
  const url = new URL(configuredApiUrl || PENKRA_PRODUCTION_API_URL);
  const isLocalHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error(
      "PENKRA_API_URL must use HTTPS, except for localhost development.",
    );
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
