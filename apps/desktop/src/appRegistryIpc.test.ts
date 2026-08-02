import { describe, expect, it } from "vitest";

import {
  parseRegistryArtifactRequest,
  parseRegistryGetRequest,
  parseRegistryListRequest,
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
    expect(() => parseRegistryListRequest({ limit: 101 })).toThrow(
      "Invalid App registry request",
    );
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
});
