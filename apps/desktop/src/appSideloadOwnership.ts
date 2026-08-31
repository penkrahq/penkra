// FILE: appSideloadOwnership.ts
// Purpose: Authorizes a local App identity against the signed-in developer's registry ownership.
// Layer: Trusted desktop App installation policy

import type { PenkraAppManifest } from "@penkra/sdk";

import type { DevelopmentAppIdentity, RegistryAppIdentity } from "./appInstallationState";
import type { AppRegistryClient } from "./appRegistryClient";

export interface AuthorizedAppSideloadIdentity {
  developmentIdentity: DevelopmentAppIdentity;
  registryIdentity?: RegistryAppIdentity;
}

export async function authorizeAppSideloadIdentity(input: {
  manifest: Pick<PenkraAppManifest, "id" | "slug" | "permissions">;
  registry: Pick<AppRegistryClient, "developerClaimAppSideloadIdentity">;
}): Promise<AuthorizedAppSideloadIdentity> {
  const identityPermission = (input.manifest.permissions ?? []).find(
    (permission) => permission.name === "account-identity",
  );
  const claimed = await input.registry.developerClaimAppSideloadIdentity({
    identifier: input.manifest.id,
    slug: input.manifest.slug,
    identityAudience: identityPermission?.audience ?? null,
  });
  return {
    developmentIdentity: { id: claimed.developmentIdentityId },
    ...(claimed.registryIdentity === undefined
      ? {}
      : { registryIdentity: claimed.registryIdentity }),
  };
}
