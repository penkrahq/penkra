/** Classify terminal provider authentication errors without exposing their text as guidance. */
export type ProviderAuthFailureKind = "provider-rejected" | "reauth-required";

export interface ProviderAuthFailure {
  readonly kind: ProviderAuthFailureKind;
  readonly summary: string;
  readonly detail: string;
}

const HTTP_UNAUTHORIZED =
  /(?:\b401\b|unauthori[sz]ed|authentication required|login required|sign.in required|invalid.api.key|incorrect.api.key)/i;
const EXPIRED_SIGN_IN =
  /(?:refresh token|sign.in|login|oauth|credential).{0,65}(?:expired|revoked|invalid|required)|(?:expired|revoked|invalid).{0,65}(?:refresh token|sign.in|login|oauth)/i;
const SUBSCRIPTION_SIGN_IN_METHODS = new Set(["chatgpt", "claude-account"]);

export function classifyProviderAuthFailure(input: {
  readonly detail: string;
  readonly authenticationMethodId: string | null;
  /** True only when the adapter observed a successful refresh before this failure. */
  readonly refreshedSuccessfully?: boolean;
}): ProviderAuthFailure | null {
  if (!HTTP_UNAUTHORIZED.test(input.detail) && !EXPIRED_SIGN_IN.test(input.detail)) return null;
  const providerRejected =
    !EXPIRED_SIGN_IN.test(input.detail) &&
    (input.refreshedSuccessfully === true ||
      (input.authenticationMethodId !== null &&
        SUBSCRIPTION_SIGN_IN_METHODS.has(input.authenticationMethodId) &&
        /\b401\b/.test(input.detail)));
  const kind: ProviderAuthFailureKind = providerRejected ? "provider-rejected" : "reauth-required";
  return {
    kind,
    summary: providerRejected
      ? "The provider is rejecting this Connection. It may be temporarily unavailable. Penkra has paused new turns and will retry automatically."
      : "This Connection needs sign-in again. Penkra has paused new turns. Retry or re-authenticate the Connection.",
    detail: input.detail,
  };
}
