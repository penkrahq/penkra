import { describe, expect, it } from "vitest";

import { resolvePenkraAccountServiceEndpoints } from "./accountServiceEndpoints";

describe("Penkra account service endpoints", () => {
  it("uses live Penkra services when source development has no override", () => {
    expect(resolvePenkraAccountServiceEndpoints({})).toEqual({
      apiUrl: "https://api.penkra.com",
      authBaseUrl: "https://api.penkra.com/auth",
      websiteOrigin: "https://penkra.com",
    });
  });

  it("accepts the paired localhost endpoints injected by Penkra Dev", () => {
    expect(
      resolvePenkraAccountServiceEndpoints({
        configuredApiUrl: "http://127.0.0.1:3012/",
        configuredWebsiteOrigin: "http://localhost:3000/sign-in",
      }),
    ).toEqual({
      apiUrl: "http://127.0.0.1:3012",
      authBaseUrl: "http://127.0.0.1:3012/auth",
      websiteOrigin: "http://localhost:3000",
    });
  });

  it("rejects partial overrides that would mix account environments", () => {
    expect(() =>
      resolvePenkraAccountServiceEndpoints({
        configuredApiUrl: "http://127.0.0.1:3012",
      }),
    ).toThrow(/configured together/);
    expect(() =>
      resolvePenkraAccountServiceEndpoints({
        configuredWebsiteOrigin: "http://localhost:3000",
      }),
    ).toThrow(/configured together/);
  });

  it("rejects insecure remote endpoints", () => {
    expect(() =>
      resolvePenkraAccountServiceEndpoints({
        configuredApiUrl: "http://example.com",
        configuredWebsiteOrigin: "https://example.com",
      }),
    ).toThrow(/HTTPS/);
  });
});
