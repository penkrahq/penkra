// FILE: localOpenCodeConfig.ts
// Purpose: What OpenCode sees for the Local provider: one OpenAI-compatible
// provider ("penkra-local") pointing at Penkra's loopback proxy, and nothing
// else. Plus the picker descriptors for the curated models.

import type { LocalModelListing as LocalModelListingWire, ProviderModelDescriptor } from "@penkra/contracts";

import { LOCAL_OPENCODE_PROVIDER_ID } from "../providerConnectionManifests.ts";
import type { LocalModelListing, LocalModelService } from "./localModelService.ts";

export const localModelSlug = (modelId: string) => `${LOCAL_OPENCODE_PROVIDER_ID}/${modelId}`;

export async function buildLocalOpenCodeProviderConfig(service: LocalModelService) {
  const baseURL = await service.proxyBaseUrl();
  return {
    enabled_providers: [LOCAL_OPENCODE_PROVIDER_ID],
    provider: {
      [LOCAL_OPENCODE_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "This Mac",
        // No request timeout: a first turn may wait for the model to download.
        options: { baseURL, apiKey: "local", timeout: false },
        models: Object.fromEntries(
          service.catalog().map((m) => [
            m.id,
            {
              name: m.label,
              tool_call: true,
              reasoning: true,
              limit: { context: m.contextTokens, output: m.maxOutputTokens },
            },
          ]),
        ),
      },
    },
  };
}

export function localModelDescriptors(listings: readonly LocalModelListing[]): ProviderModelDescriptor[] {
  return listings.map((listing, index) => ({
    slug: localModelSlug(listing.entry.id),
    name: listing.entry.label,
    description: listing.entry.note,
    upstreamProviderId: LOCAL_OPENCODE_PROVIDER_ID,
    upstreamProviderName: "This Mac",
    ...(index === 0 ? { isDefault: true as const } : {}),
    contextWindowOptions: localContextWindowOptions(listing.entry.contextTokens),
    defaultContextWindow: String(listing.entry.contextTokens),
    local: {
      downloadGb: listing.entry.downloadGb,
      downloaded: listing.downloaded,
      ...(listing.unavailableReason ? { unavailableReason: listing.unavailableReason } : {}),
    },
  }));
}

export const localModelIdFromSlug = (slug: string) =>
  slug.startsWith(`${LOCAL_OPENCODE_PROVIDER_ID}/`) ? slug.slice(LOCAL_OPENCODE_PROVIDER_ID.length + 1) : slug;

export function toLocalModelListings(listings: readonly LocalModelListing[]): LocalModelListingWire[] {
  return listings.map((l) => ({
    slug: localModelSlug(l.entry.id),
    name: l.entry.label,
    note: l.entry.note,
    downloadGb: l.entry.downloadGb,
    minMemoryGb: l.entry.minMemoryGb,
    downloaded: l.downloaded,
    unavailableReason: l.unavailableReason,
    download:
      l.download.kind === "downloading"
        ? { kind: "downloading", ...l.download.progress }
        : l.download.kind === "failed"
          ? { kind: "failed", message: l.download.message }
          : { kind: "idle" },
  }));
}

/**
 * Auto-compaction stops for on-device models. Their windows are far below the
 * 200K-and-up stops of hosted models, and a smaller window keeps every turn's
 * prompt read short on a Mac. The default is the model's full window.
 */
export function localContextWindowOptions(maximum: number) {
  const stops = [...[8_192, 16_384, 32_768, 65_536].filter((n) => n < maximum), maximum];
  return stops.map((tokens) => ({
    value: String(tokens),
    label: `${Math.round(tokens / 1024)}K`,
    ...(tokens === maximum ? { isDefault: true as const } : {}),
  }));
}
