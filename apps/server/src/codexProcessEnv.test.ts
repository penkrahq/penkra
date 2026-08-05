import { describe, expect, it, vi } from "vitest";

import {
  disableRawComputerUsePluginServer,
  linkOrCopyCodexOverlayEntry,
  prioritizeCodexOverlayEntries,
  removeReservedPenkraMcpServer,
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

  it("forces the bundled raw Computer Use server off", () => {
    const config = [
      'model = "gpt-5"',
      '[plugins."computer-use@openai-bundled".mcp_servers."computer-use"]',
      "enabled = true",
      'enabled_tools = ["get_app_state"]',
    ].join("\n");

    expect(disableRawComputerUsePluginServer(config)).toBe(
      [
        'model = "gpt-5"',
        '[plugins."computer-use@openai-bundled".mcp_servers."computer-use"]',
        "enabled = false",
        'enabled_tools = ["get_app_state"]',
      ].join("\n"),
    );
  });

  it("adds a raw Computer Use server denial when the source config omitted it", () => {
    expect(disableRawComputerUsePluginServer('model = "gpt-5"')).toBe(
      [
        'model = "gpt-5"',
        "",
        '[plugins."computer-use@openai-bundled".mcp_servers."computer-use"]',
        "enabled = false",
        "",
      ].join("\n"),
    );
  });
});
