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
