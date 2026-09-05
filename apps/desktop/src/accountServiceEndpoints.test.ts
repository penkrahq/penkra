import { describe, expect, it } from "vitest";

import {
  initializePenkraAccountServiceEnvironment,
  resolvePenkraAccountServiceEndpoints,
} from "./accountServiceEndpoints";

describe("Penkra account service endpoints", () => {
  it("recovers the production API-only environment inherited from older desktop updates", () => {
    const env = { PENKRA_API_URL: "https://api.penkra.com" };
    const endpoints = initializePenkraAccountServiceEnvironment(env);
    expect(endpoints.websiteOrigin).toBe("https://penkra.com");
    expect(env).toEqual({
      PENKRA_API_URL: "https://api.penkra.com",
      PENKRA_WEBSITE_ORIGIN: "https://penkra.com",
    });
    expect(initializePenkraAccountServiceEnvironment({ ...env })).toEqual(endpoints);
  });

  it.each([
    {},
    { PENKRA_API_URL: "http://127.0.0.1:3012/", PENKRA_WEBSITE_ORIGIN: "http://localhost:3000" },
    { PENKRA_API_URL: "https://api.example.com", PENKRA_WEBSITE_ORIGIN: "https://example.com" },
  ])("exports a complete stable pair for subsequent child launches: %j", (configured) => {
    const env: NodeJS.ProcessEnv = { ...configured, UNRELATED: "preserved" };
    const endpoints = initializePenkraAccountServiceEnvironment(env);
    expect(env.PENKRA_API_URL).toBe(endpoints.apiUrl);
    expect(env.PENKRA_WEBSITE_ORIGIN).toBe(endpoints.websiteOrigin);
    expect(env.UNRELATED).toBe("preserved");
    expect(initializePenkraAccountServiceEnvironment({ ...env })).toEqual(endpoints);
  });

  it("does not repair or mutate a partial custom account environment", () => {
    const env = { PENKRA_API_URL: "https://api.example.com" };
    expect(() => initializePenkraAccountServiceEnvironment(env)).toThrow(/configured together/);
    expect(env).toEqual({ PENKRA_API_URL: "https://api.example.com" });
  });
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
