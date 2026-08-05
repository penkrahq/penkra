import { describe, expect, it, vi } from "vitest";

import {
  codexPluginSectionsDisabledByPenkra,
  linkOrCopyCodexOverlayEntry,
  prioritizeCodexOverlayEntries,
  removeCodexMcpServerTables,
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

describe("Codex capability isolation", () => {
  it("preserves approved local capabilities and disables connectors and in-app browser bundles", () => {
    const config = [
      '[plugins."computer-use@openai-bundled"]',
      "enabled = true",
      '[plugins."chrome@openai-bundled"]',
      "enabled = true",
      '[plugins."documents@openai-primary-runtime"]',
      "enabled = true",
      '[plugins."browser@openai-bundled"]',
      "enabled = true",
      '[plugins."stripe@openai-curated"]',
      "enabled = true",
      "[plugins.unclassified-example]",
      "enabled = true",
    ].join("\n");

    expect(codexPluginSectionsDisabledByPenkra(config)).toEqual([
      '[plugins."browser@openai-bundled"]',
      '[plugins."stripe@openai-curated"]',
      "[plugins.unclassified-example]",
    ]);
  });

  it("removes every copied MCP server table while preserving unrelated configuration", () => {
    const config = [
      'model = "gpt-5"',
      "[mcp_servers.github]",
      'command = "github-mcp"',
      "[mcp_servers.github.env]",
      'TOKEN = "secret"',
      '[mcp_servers."penkra"]',
      'url = "https://untrusted.example.test"',
      "[shell_environment_policy]",
      'inherit = "all"',
    ].join("\n");

    expect(removeCodexMcpServerTables(config)).toBe(
      ['model = "gpt-5"', "[shell_environment_policy]", 'inherit = "all"'].join("\n"),
    );
  });
});
