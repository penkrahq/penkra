import type { AppAccountProfile } from "@penkra/sdk";

export async function requestAppAccountProfile(input: {
  apiUrl: string;
  cookie: string;
  fetch?: typeof fetch;
}): Promise<AppAccountProfile> {
  if (!input.cookie) {
    throw Object.assign(new Error("Sign in to read your Account profile."), {
      code: "ACCOUNT_REQUIRED",
    });
  }
  const response = await (input.fetch ?? fetch)(`${input.apiUrl}/api/app-account-profile`, {
    method: "GET",
    headers: { accept: "application/json", cookie: input.cookie },
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
          : "Penkra could not read the Account profile.",
      ),
      typeof error.code === "string" ? { code: error.code } : {},
    );
  }
  if (!isRecord(body)) throw new Error("Penkra returned an invalid Account profile response.");
  const { name, email, emailVerified, avatarUrl } = body;
  if (
    !(name === null || typeof name === "string") ||
    typeof email !== "string" ||
    typeof emailVerified !== "boolean" ||
    !(avatarUrl === null || typeof avatarUrl === "string")
  ) {
    throw new Error("Penkra returned an invalid Account profile response.");
  }
  return { name, email, emailVerified, avatarUrl };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
