// FILE: appSideloadOwnership.ts
// Purpose: Authorizes a local App identity against the signed-in developer's registry ownership.
// Layer: Trusted desktop App installation policy

import type { PenkraAppManifest } from "@penkra/sdk";

import type { RegistryAppIdentity } from "./appInstallationState";
import type { AppRegistryClient, RegistryAppIdentifierOwnership } from "./appRegistryClient";

export async function authorizeAppSideloadIdentity(input: {
  manifest: Pick<PenkraAppManifest, "id" | "slug">;
  registry: Pick<AppRegistryClient, "developerGetAppIdentifierOwnership">;
}): Promise<RegistryAppIdentity | undefined> {
  const ownership: RegistryAppIdentifierOwnership =
    await input.registry.developerGetAppIdentifierOwnership(input.manifest.id);
  if (ownership.status === "unregistered") return undefined;
  if (ownership.status === "registered-to-another-account") {
    throw new Error(
      `App identifier ${input.manifest.id} is registered to another developer account and cannot be sideloaded.`,
    );
  }
  if (ownership.slug !== input.manifest.slug) {
    throw new Error(
      `App identifier ${input.manifest.id} is registered with slug ${ownership.slug}, not ${input.manifest.slug}.`,
    );
  }
  return { appId: ownership.appId, publisherId: ownership.publisherId };
}
