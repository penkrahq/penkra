import { describe, expect, it } from "vitest";

import { buildProviderChildEnvironment } from "./providerChildEnvironment";

describe("buildProviderChildEnvironment", () => {
  it("strips Penkra control-plane and inherited native capabilities", () => {
    const env = buildProviderChildEnvironment({
      provider: "acp",
      baseEnv: {
        PATH: "/usr/bin",
        HOME: "/home/test",
        OPENAI_API_KEY: "provider-key",
        PENKRA_AUTH_TOKEN: "control-plane-secret",
        NODE_OPTIONS: "--require=/tmp/inject.js",
      },
      managedConnection: false,
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/test", OPENAI_API_KEY: "provider-key" });
  });

  it("admits only explicitly granted capability keys", () => {
    const env = buildProviderChildEnvironment({
      provider: "codex",
      baseEnv: {
        PENKRA_AUTH_TOKEN: "secret",
        PENKRA_TEST_CONTROL_SOCKET: "/tmp/control.sock",
        NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS: "/tmp/control.sock",
      },
      inheritedPenkraKeys: ["PENKRA_TEST_CONTROL_SOCKET"],
      inheritedNativeCapabilityKeys: ["NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS"],
    });
    expect(env).toEqual({
      PENKRA_TEST_CONTROL_SOCKET: "/tmp/control.sock",
      NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS: "/tmp/control.sock",
    });
  });

  it("does not let overlays bypass the capability policy", () => {
    const env = buildProviderChildEnvironment({
      provider: "opencode",
      baseEnv: { PATH: "/usr/bin" },
      overrides: {
        OPENCODE_EXPERIMENTAL_WEBSOCKETS: "true",
        PENKRA_AUTH_TOKEN: "secret",
        NODE_OPTIONS: "--require=/tmp/inject.js",
      },
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      OPENCODE_EXPERIMENTAL_WEBSOCKETS: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    });
  });

  it("gives managed harnesses only their selected credential and isolated home", () => {
    const env = buildProviderChildEnvironment({
      provider: "codex",
      baseEnv: {
        PATH: "/usr/bin",
        HOME: "/Users/operator",
        OPENAI_API_KEY: "global",
        RANDOM_PROFILE_SETTING: "global-profile-state",
      },
      credentialOverrides: { OPENAI_API_KEY: "selected" },
      isolation: {
        homePath: "/managed/home",
        xdgConfigHome: "/managed/config",
        xdgDataHome: "/managed/data",
        xdgCacheHome: "/managed/cache",
        xdgStateHome: "/managed/state",
      },
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/managed/home",
      XDG_CONFIG_HOME: "/managed/config",
      XDG_DATA_HOME: "/managed/data",
      XDG_CACHE_HOME: "/managed/cache",
      XDG_STATE_HOME: "/managed/state",
      OPENAI_API_KEY: "selected",
    });
  });

  it("keeps the OS home available to Claude's namespaced native Keychain", () => {
    const env = buildProviderChildEnvironment({
      provider: "claude",
      baseEnv: { PATH: "/usr/bin", HOME: "/Users/operator", ANTHROPIC_API_KEY: "global" },
      isolation: {
        homePath: "/managed/home",
        xdgConfigHome: "/managed/config",
        xdgDataHome: "/managed/data",
        xdgCacheHome: "/managed/cache",
        xdgStateHome: "/managed/state",
      },
      preserveOsHome: true,
      overrides: { CLAUDE_CONFIG_DIR: "/managed/claude" },
    });
    expect(env.HOME).toBe("/Users/operator");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/managed/claude");
  });

  it("keeps managed providers from mutating their own installations", () => {
    expect(buildProviderChildEnvironment({ provider: "claude", baseEnv: {} }).DISABLE_UPDATES).toBe(
      "1",
    );
    expect(
      buildProviderChildEnvironment({ provider: "opencode", baseEnv: {} })
        .OPENCODE_DISABLE_AUTOUPDATE,
    ).toBe("1");
  });
});
