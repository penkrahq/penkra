import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadOpenCodeSharedMcpConfig } from "./openCodeSharedMcpConfig.ts";

describe("loadOpenCodeSharedMcpConfig", () => {
  it("merges OpenCode's documented global order and excludes Penkra", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "penkra-opencode-shared-mcp-"));
    const configDir = path.join(home, ".config", "opencode");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({ mcp: { pencil: { type: "local", command: ["old"] } } }),
    );
    await writeFile(
      path.join(configDir, "opencode.jsonc"),
      `{
        // Later global source wins for this server.
        "mcp": {
          "pencil": { "type": "local", "command": ["pencil", "mcp"], },
          "penkra": { "type": "remote", "url": "https://must-not-copy.invalid" }
        }
      }`,
    );

    expect(JSON.parse((await loadOpenCodeSharedMcpConfig(home))!)).toEqual({
      mcp: { pencil: { type: "local", command: ["pencil", "mcp"] } },
    });
  });
});
