// FILE: providerNativeStatePaths.ts
// Purpose: Deterministic opaque filesystem paths for native provider generations.

import { createHash } from "node:crypto";
import * as Path from "node:path";

export const providerOpaquePathKey = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const providerNativeStateRoot = (stateDir: string, generationId: string): string =>
  Path.join(stateDir, "provider-native-state", providerOpaquePathKey(generationId));

export const providerConnectionProfileRoot = (stateDir: string, profileIdentity: string): string =>
  Path.join(stateDir, "provider-connections", providerOpaquePathKey(profileIdentity));

const PROVIDER_PROFILE_REF_PREFIX = "provider-profile:";

/**
 * Resolve an immutable provider profile reference without changing the path
 * used by released Connection-id-backed profiles.
 */
export const providerCredentialProfileIdentity = (profileRef: string): string | null => {
  if (!profileRef.startsWith(PROVIDER_PROFILE_REF_PREFIX)) return null;
  const identity = profileRef.slice(PROVIDER_PROFILE_REF_PREFIX.length).trim();
  return identity.length > 0 ? identity : null;
};

export const providerCredentialProfileRoot = (
  stateDir: string,
  profileRef: string,
): string | null => {
  const identity = providerCredentialProfileIdentity(profileRef);
  return identity === null ? null : providerConnectionProfileRoot(stateDir, identity);
};
