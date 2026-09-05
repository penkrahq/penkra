import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("native installer transaction safety", () => {
  it("refuses installer execution outside a disposable CI runner", () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./verify-native-desktop-upgrade.mjs", import.meta.url))],
      { env: { ...process.env, GITHUB_ACTIONS: "false" }, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ERR_ASSERTION");
    expect(result.stdout).toBe("");
  });
});
