import { createHash } from "node:crypto";
import {
  PINNED_PROVIDER_KINDS,
  pinnedProviderArtifact,
} from "../src/provider/pinnedProviderRuntimes.ts";
import type { ManagedProviderArtifact } from "../src/provider/managedProviderArtifact.ts";

/** Release verification consumes committed identities; it never discovers a version. */
export async function verifyPinnedArtifact(
  artifact: ManagedProviderArtifact,
  fetchArtifact: (url: string) => Promise<Response> = fetch,
) {
  const response = await fetchArtifact(artifact.url);
  if (!response.ok || !response.body)
    throw new Error(
      `Pinned artifact download rejected: HTTP ${response.status}, ${artifact.provider} ${artifact.version}`,
    );
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  const digest = hash.digest("hex");
  if (digest !== artifact.sha256)
    throw new Error(
      `Pinned artifact checksum mismatch for ${artifact.provider} ${artifact.version}: expected ${artifact.sha256}, received ${digest}`,
    );
  return { provider: artifact.provider, version: artifact.version, sha256: digest, bytes };
}

if (import.meta.main) {
  for (const provider of PINNED_PROVIDER_KINDS)
    console.log(JSON.stringify(await verifyPinnedArtifact(pinnedProviderArtifact(provider))));
}
