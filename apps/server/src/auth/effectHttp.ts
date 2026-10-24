import { Option } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import type { AuthError, AuthRequest } from "./Services/ServerAuth";

export function makeEffectAuthRequest(request: HttpServerRequest.HttpServerRequest): AuthRequest {
  const url = Option.getOrUndefined(HttpServerRequest.toURL(request));
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return {
    headers,
    cookies: request.cookies,
    ...(url ? { url } : {}),
  };
}

export function authErrorResponse(error: AuthError) {
  return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status ?? 500 });
}
