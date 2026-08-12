import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { synchronizeClaudeSharedMcpConfig } from "./claudeSharedMcpConfig.ts";

describe("synchronizeClaudeSharedMcpConfig", () => {
  it("copies only shared MCP definitions and preserves isolated account state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "penkra-claude-shared-mcp-"));
    const sourcePath = path.join(root, "source.json");
    const targetDir = path.join(root, "profile");
    await writeFile(
      sourcePath,
      JSON.stringify({
        oauthAccount: { emailAddress: "global@example.com" },
        mcpServers: {
          pencil: { command: "pencil", args: ["mcp"] },
          penkra: { type: "http", url: "https://must-not-copy.invalid" },
        },
      }),
    );
    await import("node:fs/promises").then(({ mkdir }) => mkdir(targetDir, { recursive: true }));
    await writeFile(
      path.join(targetDir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "isolated@example.com" }, numStartups: 4 }),
    );

    await synchronizeClaudeSharedMcpConfig({
      sourceConfigPath: sourcePath,
      targetConfigDir: targetDir,
    });

    const result = JSON.parse(await readFile(path.join(targetDir, ".claude.json"), "utf8"));
    expect(result).toEqual({
      oauthAccount: { emailAddress: "isolated@example.com" },
      numStartups: 4,
      mcpServers: { pencil: { command: "pencil", args: ["mcp"] } },
    });
  });
});
