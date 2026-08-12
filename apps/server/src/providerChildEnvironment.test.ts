import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { buildProviderChildEnvironment } from "./providerChildEnvironment";

describe("buildProviderChildEnvironment", () => {
  it("strips Penkra control-plane and inherited native capabilities", () => {
    const env = buildProviderChildEnvironment({
      provider: "antigravity",
      baseEnv: {
        PATH: "/usr/bin",
        HOME: "/home/test",
        GEMINI_API_KEY: "provider-key",
        PENKRA_AUTH_TOKEN: "control-plane-secret",
        PENKRA_TEST_CONTROL_SOCKET: "/tmp/control.sock",
        NODE_OPTIONS: "--require=/tmp/inject.js",
        NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS: "/tmp/other.sock",
      },
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      GEMINI_API_KEY: "provider-key",
    });
  });

  it("admits only explicitly granted capability keys", () => {
    const env = buildProviderChildEnvironment({
      provider: "codex",
      baseEnv: {
        PENKRA_AUTH_TOKEN: "control-plane-secret",
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
        PENKRA_AUTH_TOKEN: "overlaid-control-plane-secret",
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
        OPENAI_API_KEY: "global-openai-secret",
        ANTHROPIC_API_KEY: "global-anthropic-secret",
        RANDOM_PROFILE_SETTING: "global-profile-state",
      },
      credentialOverrides: { OPENAI_API_KEY: "selected-connection-secret" },
      isolation: {
        homePath: "/managed/connections/personal/home",
        xdgConfigHome: "/managed/connections/personal/xdg-config",
        xdgDataHome: "/managed/connections/personal/xdg-data",
        xdgCacheHome: "/managed/connections/personal/xdg-cache",
        xdgStateHome: "/managed/connections/personal/xdg-state",
      },
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/managed/connections/personal/home",
      XDG_CONFIG_HOME: "/managed/connections/personal/xdg-config",
      XDG_DATA_HOME: "/managed/connections/personal/xdg-data",
      XDG_CACHE_HOME: "/managed/connections/personal/xdg-cache",
      XDG_STATE_HOME: "/managed/connections/personal/xdg-state",
      OPENAI_API_KEY: "selected-connection-secret",
    });
  });

  it("keeps the OS home available to an explicitly namespaced native Keychain", () => {
    const env = buildProviderChildEnvironment({
      provider: "claude",
      baseEnv: {
        PATH: "/usr/bin",
        HOME: "/Users/operator",
        ANTHROPIC_API_KEY: "global-anthropic-secret",
      },
      isolation: {
        homePath: "/managed/connections/personal/home",
        xdgConfigHome: "/managed/connections/personal/xdg-config",
        xdgDataHome: "/managed/connections/personal/xdg-data",
        xdgCacheHome: "/managed/connections/personal/xdg-cache",
        xdgStateHome: "/managed/connections/personal/xdg-state",
      },
      preserveOsHome: true,
      overrides: {
        CLAUDE_CONFIG_DIR: "/managed/connections/personal/claude-config",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: "/managed/connections/personal/claude-config",
      },
    });

    expect(env.HOME).toBe("/Users/operator");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/managed/connections/personal/claude-config");
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe("/managed/connections/personal/claude-config");
    expect(env.XDG_CONFIG_HOME).toBe("/managed/connections/personal/xdg-config");
  });

  it("keeps managed providers from mutating their own installations", () => {
    expect(
      buildProviderChildEnvironment({
        provider: "claude",
        baseEnv: { DISABLE_UPDATES: "0" },
      }).DISABLE_UPDATES,
    ).toBe("1");
    expect(
      buildProviderChildEnvironment({
        provider: "opencode",
        baseEnv: { OPENCODE_DISABLE_AUTOUPDATE: "0" },
      }).OPENCODE_DISABLE_AUTOUPDATE,
    ).toBe("1");
  });

  it.each([
    ["cursor", "CURSOR_API_KEY", "FACTORY_API_KEY"],
    ["droid", "FACTORY_API_KEY", "XAI_API_KEY"],
    ["antigravity", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"],
    ["grok", "XAI_API_KEY", "GOOGLE_API_KEY"],
  ] as const)(
    "grants %s only its declared provider credential group",
    (provider, grantedKey, unrelatedKey) => {
      const env = buildProviderChildEnvironment({
        provider,
        baseEnv: {
          PATH: "/usr/bin",
          [grantedKey]: "native-provider-secret",
          [unrelatedKey]: "unrelated-provider-secret",
        },
      });

      expect(env[grantedKey]).toBe("native-provider-secret");
      expect(env[unrelatedKey]).toBeUndefined();
    },
  );

  it.each(["kilo", "pi"] as const)(
    "preserves upstream credential discovery for multi-provider %s",
    (provider) => {
      const env = buildProviderChildEnvironment({
        provider,
        baseEnv: {
          ANTHROPIC_API_KEY: "anthropic-secret",
          GEMINI_API_KEY: "gemini-secret",
        },
      });

      expect(env.ANTHROPIC_API_KEY).toBe("anthropic-secret");
      expect(env.GEMINI_API_KEY).toBe("gemini-secret");
    },
  );

  it("keeps stripped authority absent in descendants", () => {
    const env = buildProviderChildEnvironment({
      provider: "grok",
      baseEnv: {
        XAI_API_KEY: "grok-secret",
        ANTHROPIC_API_KEY: "unrelated-secret",
        PENKRA_AUTH_TOKEN: "control-plane-secret",
      },
    });
    const descendantScript =
      "process.stdout.write(JSON.stringify({ xai: process.env.XAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY, penkra: process.env.PENKRA_AUTH_TOKEN }))";
    const parentScript = `const { spawnSync } = require("node:child_process"); const result = spawnSync(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { env: process.env, encoding: "utf8" }); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);`;
    const result = spawnSync(process.execPath, ["-e", parentScript], {
      env,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ xai: "grok-secret" });
  });
});
