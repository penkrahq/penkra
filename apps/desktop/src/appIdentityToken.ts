// FILE: appIdentityToken.ts
// Purpose: Requests a short-lived, audience-bound Account identity token without exposing cookies.
// Layer: Trusted desktop main process

import type { AppIdentityToken } from "@penkra/sdk";

const APP_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+)+$/;
const AUDIENCE_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?$/;

export async function requestAppIdentityToken(input: {
  apiUrl: string;
  appId: string;
  spaceId: string;
  audience: string;
  cookie: string;
  fetch?: typeof fetch;
}): Promise<AppIdentityToken> {
  if (!APP_ID_PATTERN.test(input.appId)) throw new Error("App identity is invalid.");
  if (!input.spaceId || input.spaceId.length > 200) throw new Error("Space identity is invalid.");
  if (!AUDIENCE_PATTERN.test(input.audience)) throw new Error("Identity audience is invalid.");
  if (!input.cookie) {
    throw Object.assign(new Error("Sign in to request an Account identity token."), {
      code: "ACCOUNT_REQUIRED",
    });
  }
  const response = await (input.fetch ?? fetch)(`${input.apiUrl}/api/app-identity/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie: input.cookie,
    },
    body: JSON.stringify({
      appId: input.appId,
      spaceId: input.spaceId,
      audience: input.audience,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const error = isRecord(body) ? body : {};
    throw Object.assign(
      new Error(
        typeof error.message === "string"
          ? error.message
          : "Penkra could not issue an App identity token.",
      ),
      typeof error.code === "string" ? { code: error.code } : {},
    );
  }
  if (
    !isRecord(body) ||
    typeof body.token !== "string" ||
    body.token.length > 16_384 ||
    typeof body.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(body.expiresAt))
  ) {
    throw new Error("Penkra returned an invalid App identity token response.");
  }
  return { token: body.token, expiresAt: body.expiresAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
