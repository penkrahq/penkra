import { describe, expect, it } from "vitest";

import { resolvePenkraAccountServiceEndpoints } from "./accountServiceEndpoints";

describe("Penkra account service endpoints", () => {
  it("uses live Penkra services when source development has no override", () => {
    expect(resolvePenkraAccountServiceEndpoints({})).toEqual({
      apiUrl: "https://api.penkra.com",
      authOrigin: "https://penkra.com",
    });
  });

  it("accepts the paired localhost endpoints injected by Penkra Dev", () => {
    expect(
      resolvePenkraAccountServiceEndpoints({
        configuredApiUrl: "http://127.0.0.1:3012/",
        configuredAuthOrigin: "http://localhost:3000/sign-in",
      }),
    ).toEqual({
      apiUrl: "http://127.0.0.1:3012",
      authOrigin: "http://localhost:3000",
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
        configuredAuthOrigin: "http://localhost:3000",
      }),
    ).toThrow(/configured together/);
  });

  it("rejects insecure remote endpoints", () => {
    expect(() =>
      resolvePenkraAccountServiceEndpoints({
        configuredApiUrl: "http://example.com",
        configuredAuthOrigin: "https://example.com",
      }),
    ).toThrow(/HTTPS/);
  });
});
