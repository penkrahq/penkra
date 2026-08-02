// FILE: appSkillsCatalog.ts
// Purpose: Loads enabled, Space-scoped Agent Skills from verified immutable App packages.
// Layer: Local server to trusted desktop capability bridge

import type { ProviderSkillDescriptor } from "@penkra/contracts";

import { requestAppRuntimeBridge } from "./appRuntimeCli";
import { readSkillDescriptor } from "./provider/skillsCatalog";

interface AppSkillBridgeEntry {
  appId: string;
  slug: string;
  name: string;
  path: string;
  skillPath: string;
  enabled: boolean;
  scope: string;
}

export async function discoverEnabledAppSkills(
  spaceId: string,
  request: typeof requestAppRuntimeBridge = requestAppRuntimeBridge,
): Promise<ProviderSkillDescriptor[]> {
  const raw = await request("skills.list", { spaceId });
  const entries = parseEntries(raw);
  const descriptors = await Promise.all(
    entries
      .filter((entry) => entry.enabled)
      .map((entry) => readSkillDescriptor({ skillPath: entry.skillPath, scope: entry.scope })),
  );
  return descriptors.filter(
    (descriptor): descriptor is ProviderSkillDescriptor => descriptor !== null,
  );
}

function parseEntries(value: unknown): AppSkillBridgeEntry[] {
  if (!Array.isArray(value)) throw new Error("Desktop returned an invalid App skill catalog.");
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("Desktop returned an invalid App skill catalog entry.");
    }
    const record = candidate as Record<string, unknown>;
    const required = (key: string): string => {
      const field = record[key];
      if (typeof field !== "string" || !field.trim()) {
        throw new Error(`Desktop App skill catalog ${key} is invalid.`);
      }
      return field;
    };
    if (typeof record.enabled !== "boolean") {
      throw new Error("Desktop App skill catalog enabled state is invalid.");
    }
    const slug = required("slug");
    const scope = required("scope");
    if (scope !== `app:${slug}`) throw new Error("Desktop App skill attribution is invalid.");
    return {
      appId: required("appId"),
      slug,
      name: required("name"),
      path: required("path"),
      skillPath: required("skillPath"),
      enabled: record.enabled,
      scope,
    };
  });
}
