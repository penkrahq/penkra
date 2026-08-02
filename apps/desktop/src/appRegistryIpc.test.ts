import { describe, expect, it } from "vitest";

import {
  parseRegistryArtifactRequest,
  parseRegistryFeedbackRequest,
  parseRegistryGetRequest,
  parseRegistryListRequest,
  parseRegistryRatingRequest,
  parseRegistryReviewRequest,
} from "./appRegistryIpc";

describe("App registry IPC", () => {
  it("normalizes the bounded catalog request", () => {
    expect(parseRegistryListRequest({ query: " Canvas ", limit: 30 })).toEqual({
      query: "Canvas",
      limit: 30,
    });
    expect(parseRegistryListRequest(undefined)).toEqual({});
  });

  it("rejects undeclared fields and invalid bounds", () => {
    expect(() => parseRegistryListRequest({ url: "https://evil.test" })).toThrow(
      "Invalid App registry request",
    );
    expect(() => parseRegistryListRequest({ limit: 101 })).toThrow("Invalid App registry request");
  });

  it("accepts only canonical App and object identities", () => {
    expect(parseRegistryGetRequest({ slug: "canvas" })).toEqual({ slug: "canvas" });
    expect(
      parseRegistryArtifactRequest({
        id: "00000000-0000-4000-8000-000000000401",
        source: "asset",
      }),
    ).toEqual({
      id: "00000000-0000-4000-8000-000000000401",
      source: "asset",
    });
    expect(() => parseRegistryGetRequest({ slug: "Canvas" })).toThrow();
  });

  it("bounds account feedback mutations without exposing generic requests", () => {
    const appId = "00000000-0000-4000-8000-000000000401";
    expect(parseRegistryFeedbackRequest({ appId })).toEqual({ appId });
    expect(parseRegistryRatingRequest({ appId, rating: 5 })).toEqual({ appId, rating: 5 });
    expect(parseRegistryReviewRequest({ appId, body: "  Useful  " })).toEqual({
      appId,
      body: "Useful",
    });
    expect(() => parseRegistryRatingRequest({ appId, rating: 0 })).toThrow();
    expect(() => parseRegistryRatingRequest({ appId, rating: 6 })).toThrow();
    expect(() => parseRegistryReviewRequest({ appId, body: "   " })).toThrow();
    expect(() => parseRegistryReviewRequest({ appId, body: "x".repeat(10_001) })).toThrow();
  });
});
