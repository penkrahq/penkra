import { Effect } from "effect";
import { resolveManagedProviderArtifact } from "../src/provider/managedProviderArtifact.ts";
import {
  PINNED_PROVIDER_KINDS,
  PINNED_PROVIDER_RUNTIMES,
} from "../src/provider/pinnedProviderRuntimes.ts";

// This operator command is deliberately read-only. Startup uses the committed
// manifest, not the results of this query.
const results = await Promise.all(
  PINNED_PROVIDER_KINDS.map(async (provider) => {
    const pinned = PINNED_PROVIDER_RUNTIMES.providers[provider].version;
    try {
      const latest = await Effect.runPromise(
        resolveManagedProviderArtifact({ provider, version: "latest" }),
      );
      return { provider, pinned, latest: latest.version, error: null };
    } catch (error) {
      return {
        provider,
        pinned,
        latest: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }),
);
for (const result of results) {
  console.log(
    `${result.provider}\tpinned=${result.pinned}\tlatest=${result.latest ?? "unavailable"}${result.error ? `\terror=${result.error}` : ""}`,
  );
}
if (results.some((result) => result.error !== null)) process.exitCode = 1;
