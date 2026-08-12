import { describe, expect, it } from "vitest";

import {
  findManagedLoginMethod,
  findStaticCredentialMethod,
  getProviderConnectionManifest,
} from "./providerConnectionManifests";

describe("provider Connection manifests", () => {
  it("keeps Codex credentials Connection-scoped and thread state generation-scoped", () => {
    const environment = getProviderConnectionManifest("codex")?.buildStateEnvironment({
      profileRoot: "/connections/account-a",
      nativeStateRoot: "/native/thread-generation",
    });

    expect(environment?.overrides.CODEX_HOME).toBe("/connections/account-a/codex-home");
    expect(environment?.overrides.CODEX_SQLITE_HOME).toBe("/native/thread-generation/sqlite-home");
  });

  it("keeps OpenCode Zen and Go credential routing exact while allowing anonymous free Zen", () => {
    const manifest = getProviderConnectionManifest("opencode");
    const zen = findStaticCredentialMethod({
      harness: "opencode",
      authenticationTargetId: "opencode-zen",
      authenticationMethodId: "api-key",
    });
    const go = findStaticCredentialMethod({
      harness: "opencode",
      authenticationTargetId: "opencode-go",
      authenticationMethodId: "api-key",
    });

    expect(manifest?.anonymous?.authorizesInternalProvider("opencode")).toBe(true);
    expect(manifest?.anonymous?.authorizesInternalProvider("opencode-go")).toBe(false);
    expect(zen?.authorizesInternalProvider("opencode")).toBe(true);
    expect(zen?.authorizesInternalProvider("opencode-go")).toBe(false);
    expect(zen?.buildCredentialEnvironment("zen-secret")).toEqual({
      OPENCODE_AUTH_CONTENT: JSON.stringify({
        opencode: { type: "api", key: "zen-secret" },
      }),
    });
    expect(go?.authorizesInternalProvider("opencode-go")).toBe(true);
    expect(go?.authorizesInternalProvider("opencode")).toBe(false);
    expect(go?.buildCredentialEnvironment("secret")).toEqual({
      OPENCODE_AUTH_CONTENT: JSON.stringify({
        "opencode-go": { type: "api", key: "secret" },
      }),
    });
  });

  it("declares the exact Claude account and API key methods", () => {
    const manifest = getProviderConnectionManifest("claudeAgent");
    const environment = manifest?.buildStateEnvironment({
      profileRoot: "/connections/account-a",
      nativeStateRoot: "/native/thread-generation",
    });
    const account = findManagedLoginMethod({
      harness: "claudeAgent",
      authenticationTargetId: "anthropic-first-party",
      authenticationMethodId: "claude-account",
    });
    const apiKey = findStaticCredentialMethod({
      harness: "claudeAgent",
      authenticationTargetId: "anthropic-first-party",
      authenticationMethodId: "api-key",
    });

    expect(account?.loginMechanism).toBe("browser");
    expect(manifest?.preserveOsHome).toBe(process.platform === "darwin");
    expect(environment?.overrides.CLAUDE_CONFIG_DIR).toBe("/connections/account-a/claude-config");
    expect(environment?.overrides.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(
      "/connections/account-a/claude-config",
    );
    expect(apiKey?.buildCredentialEnvironment("secret")).toEqual({
      ANTHROPIC_API_KEY: "secret",
    });
  });

  it("imports ChatGPT API keys through a provider-native profile", () => {
    const apiKey = findManagedLoginMethod({
      harness: "codex",
      authenticationTargetId: "openai-first-party",
      authenticationMethodId: "api-key",
    });

    expect(apiKey?.loginMechanism).toBe("secret-import");
    expect(apiKey?.secretPlaceholder).toBe("OpenAI API key");
    expect("validateSecret" in (apiKey ?? {})).toBe(false);
  });

  it("fails closed for undeclared authentication methods", () => {
    expect(
      findStaticCredentialMethod({
        harness: "codex",
        authenticationTargetId: "openai-first-party",
        authenticationMethodId: "experimental-host-token",
      }),
    ).toBeNull();
  });
});
