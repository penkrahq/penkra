// FILE: accountAuthSignInUrl.ts
// Purpose: Carries a numbered desktop identity through the website sign-in request.

import type { PenkraDesktopFlavor } from "@penkra/shared/desktopIdentity";

export function resolvePenkraAccountSignInUrl(input: {
  readonly path: "/sign-in" | "/sign-up";
  readonly websiteOrigin: string;
  readonly desktopFlavor: PenkraDesktopFlavor;
  readonly developmentInstance?: number;
}): URL {
  const url = new URL(input.path, input.websiteOrigin);
  if (input.desktopFlavor !== "production") {
    url.searchParams.set("desktop_flavor", input.desktopFlavor);
    if ((input.developmentInstance ?? 1) > 1) {
      url.searchParams.set("desktop_instance", String(input.developmentInstance));
    }
  }
  return url;
}
