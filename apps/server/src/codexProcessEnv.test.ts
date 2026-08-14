import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  enableOfficialComputerUseRoutes,
  linkOrCopyCodexOverlayEntry,
  prioritizeCodexOverlayEntries,
  prepareManagedCodexProfileConfig,
  removeReservedPenkraMcpServer,
  removeDisabledLegacyComputerUseServer,
} from "./codexProcessEnv";

describe("linkOrCopyCodexOverlayEntry", () => {
  it("copies auth.json when symlink creation is unavailable", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlinks unavailable");
    });
    const copyFile = vi.fn(async () => undefined);

    await linkOrCopyCodexOverlayEntry(
      {
        entryName: "auth.json",
        sourcePath: "C:\\Users\\test\\.codex\\auth.json",
        targetPath: "C:\\Users\\test\\.penkra\\codex-home-overlay\\auth.json",
        type: "file",
      },
      { symlink, copyFile },
    );

    expect(symlink).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.penkra\\codex-home-overlay\\auth.json",
      "file",
    );
    expect(copyFile).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.penkra\\codex-home-overlay\\auth.json",
    );
  });

  it("keeps symlink failures visible for other overlay entries", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlinks unavailable");
    });

    await expect(
      linkOrCopyCodexOverlayEntry(
        {
          entryName: "sessions",
          sourcePath: "C:\\Users\\test\\.codex\\sessions",
          targetPath: "C:\\Users\\test\\.penkra\\codex-home-overlay\\sessions",
          type: "dir",
        },
        { symlink, copyFile: vi.fn(async () => undefined) },
      ),
    ).rejects.toThrow("symlinks unavailable");
  });
});

describe("prioritizeCodexOverlayEntries", () => {
  it("prepares auth.json before entries whose symlinks may fail first", () => {
    expect(prioritizeCodexOverlayEntries(["sessions", "auth.json", "config.toml"])).toEqual([
      "auth.json",
      "sessions",
      "config.toml",
    ]);
  });
});

describe("Codex provider configuration", () => {
  it("enables both official Computer Use routes", () => {
    expect(
      enableOfficialComputerUseRoutes(
        [
          '[plugins."computer-use@openai-bundled"]',
          "enabled = false",
          "[mcp_servers.node_repl]",
          'command = "node_repl"',
          "enabled = false",
        ].join("\n"),
      ),
    ).toContain(
      [
        '[plugins."computer-use@openai-bundled"]',
        "enabled = true",
        "[mcp_servers.node_repl]",
        'command = "node_repl"',
        "enabled = true",
      ].join("\n"),
    );
  });

  it("does not invent a node_repl executable when none is configured", () => {
    const config = enableOfficialComputerUseRoutes('model = "gpt-5"');
    expect(config).not.toContain("[mcp_servers.node_repl]");
    expect(config).toContain('[plugins."computer-use@openai-bundled"]\nenabled = true');
    expect(config).toContain(
      '[plugins."computer-use@openai-bundled".mcp_servers."computer-use"]\nenabled = true',
    );
  });

  it("removes only a disabled legacy Computer Use server that masks the plugin route", () => {
    const config = [
      "[mcp_servers.computer-use]",
      'command = "legacy-client"',
      "enabled = false",
      "[mcp_servers.computer-use.env]",
      'TOKEN = "legacy"',
      "[mcp_servers.github]",
      'command = "github-mcp"',
    ].join("\n");
    expect(removeDisabledLegacyComputerUseServer(config)).toBe(
      ["[mcp_servers.github]", 'command = "github-mcp"'].join("\n"),
    );
    expect(
      removeDisabledLegacyComputerUseServer(config.replace("enabled = false", "enabled = true")),
    ).toContain("[mcp_servers.computer-use]");
  });

  it("inherits user tools while replacing only the managed gateway", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "penkra-managed-codex-config-"));
    try {
      const codexHome = path.join(root, "connection", "codex-home");
      const sourceHomePath = path.join(root, "global");
      const sourceConfigPath = path.join(sourceHomePath, "config.toml");
      const sourceConfig = [
        '[plugins."browser@openai-bundled"]',
        "enabled = true",
        "",
        "[mcp_servers.pencil]",
        'command = "/Applications/Pen.app/Contents/MacOS/pencil-mcp"',
        "",
        "[mcp_servers.penkra]",
        'url = "https://stale.example.test/mcp"',
      ].join("\n");
      await mkdir(sourceHomePath, { recursive: true });
      await writeFile(sourceConfigPath, sourceConfig);
      await prepareManagedCodexProfileConfig({
        env: { CODEX_HOME: codexHome },
        sourceHomePath,
        cliAuthCredentialsStore: "keyring",
        appendConfigToml: [
          "[mcp_servers.penkra]",
          'url = "http://127.0.0.1:4321/mcp"',
          'bearer_token_env_var = "PENKRA_AGENT_GATEWAY_TOKEN"',
        ].join("\n"),
      });
      const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
      expect(config).toContain('[plugins."browser@openai-bundled"]');
      expect(config).toContain('cli_auth_credentials_store = "keyring"');
      expect(config).toContain("[mcp_servers.pencil]");
      expect(config).toContain("[mcp_servers.penkra]");
      expect(config).toContain('url = "http://127.0.0.1:4321/mcp"');
      expect(config).not.toContain("https://stale.example.test/mcp");
      expect(config).toContain('exclude = ["PENKRA_AGENT_GATEWAY_TOKEN"]');

      expect(await readFile(sourceConfigPath, "utf8")).toBe(sourceConfig);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes only Penkra's reserved gateway entry", () => {
    const config = [
      'model = "gpt-5"',
      'mcp_servers."penkra" = { url = "https://untrusted-dotted.example.test" }',
      "[mcp_servers]",
      'inline_server = { command = "inline" }',
      'penkra = { url = "https://untrusted-inline.example.test" }',
      "[mcp_servers.node_repl]",
      'command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"',
      "[mcp_servers.node_repl.env]",
      'SKY_CUA_SERVICE_PATH = "/Users/test/.codex/computer-use/Codex Computer Use.app"',
      "[mcp_servers.github]",
      'command = "github-mcp"',
      "[mcp_servers.github.env]",
      'TOKEN = "secret"',
      '[mcp_servers."penkra"]',
      'url = "https://untrusted.example.test"',
      "[shell_environment_policy]",
      'inherit = "all"',
    ].join("\n");

    expect(removeReservedPenkraMcpServer(config)).toBe(
      [
        'model = "gpt-5"',
        "[mcp_servers]",
        'inline_server = { command = "inline" }',
        "[mcp_servers.node_repl]",
        'command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"',
        "[mcp_servers.node_repl.env]",
        'SKY_CUA_SERVICE_PATH = "/Users/test/.codex/computer-use/Codex Computer Use.app"',
        "[mcp_servers.github]",
        'command = "github-mcp"',
        "[mcp_servers.github.env]",
        'TOKEN = "secret"',
        "[shell_environment_policy]",
        'inherit = "all"',
      ].join("\n"),
    );
  });

  it("preserves user-enabled Computer Use plugin components", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "penkra-managed-computer-use-config-"));
    try {
      const codexHome = path.join(root, "connection", "codex-home");
      const sourceHomePath = path.join(root, "global");
      await mkdir(sourceHomePath, { recursive: true });
      await writeFile(
        path.join(sourceHomePath, "config.toml"),
        [
          '[plugins."computer-use@openai-bundled"]',
          "enabled = true",
          '[plugins."computer-use@openai-bundled".mcp_servers."computer-use"]',
          "enabled = true",
          "[mcp_servers.node_repl]",
          'command = "node_repl"',
        ].join("\n"),
      );

      await prepareManagedCodexProfileConfig({
        env: { CODEX_HOME: codexHome },
        sourceHomePath,
        cliAuthCredentialsStore: "keyring",
      });

      const config = await readFile(path.join(codexHome, "config.toml"), "utf8");
      expect(config).toContain('[plugins."computer-use@openai-bundled"]');
      expect(config).toContain(
        '[plugins."computer-use@openai-bundled".mcp_servers."computer-use"]\nenabled = true',
      );
      expect(config).toContain("[mcp_servers.node_repl]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shares the official Computer Use service with an isolated managed profile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "penkra-managed-computer-use-service-"));
    try {
      const codexHome = path.join(root, "connection", "codex-home");
      const sourceHomePath = path.join(root, "global");
      const sourceComputerUsePath = path.join(sourceHomePath, "computer-use");
      await mkdir(sourceComputerUsePath, { recursive: true });
      await writeFile(path.join(sourceHomePath, "config.toml"), 'model = "gpt-5"');

      await prepareManagedCodexProfileConfig({
        env: { CODEX_HOME: codexHome },
        sourceHomePath,
        cliAuthCredentialsStore: "keyring",
      });

      expect(await readlink(path.join(codexHome, "computer-use"))).toBe(sourceComputerUsePath);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
