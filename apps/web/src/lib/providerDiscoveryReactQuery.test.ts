import { describe, expect, it } from "vitest";
import {
  isInitialModelDiscoveryPending,
  providerComposerCapabilitiesQueryOptions,
  skillsCatalogQueryOptions,
} from "./providerDiscoveryReactQuery";

describe("isInitialModelDiscoveryPending", () => {
  it("is pending only for the first fetch (loading or placeholder fetch)", () => {
    expect(
      isInitialModelDiscoveryPending({
        isLoading: true,
        isFetching: true,
        isPlaceholderData: true,
      }),
    ).toBe(true);
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: true,
        isPlaceholderData: true,
      }),
    ).toBe(true);
    // Settled catalog + background refetch must not blank the picker (#103).
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: true,
        isPlaceholderData: false,
      }),
    ).toBe(false);
    expect(
      isInitialModelDiscoveryPending({
        isLoading: false,
        isFetching: false,
        isPlaceholderData: false,
      }),
    ).toBe(false);
  });
});

describe("non-catalog discovery metadata", () => {
  it("keeps static composer capabilities and the settings inventory separate from Connection catalogs", () => {
    expect(providerComposerCapabilitiesQueryOptions("codex").queryKey).toEqual([
      "provider-discovery",
      "composer-capabilities",
      "codex",
    ]);
    const inventory = skillsCatalogQueryOptions({ cwd: "/folder" });
    expect(inventory.queryKey).toEqual(["provider-discovery", "skills-catalog", "/folder"]);
    expect(inventory.refetchOnWindowFocus).toBe(false);
  });
});
