import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { qaProviderCoverageLabel } from "../diagnostics-qa-gate";

const fixture = fileURLToPath(new URL("./scripted-codex-app-server.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const marker = "PENKRA_QA_SCRIPTED_PROVIDER_FIXTURE_V1";

describe("scripted provider QA fixture", () => {
  it("serves a real JSONL app-server process and completes or interrupts turns", async () => {
    const child = spawn(process.execPath, [fixture, "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout! });
    const received: Array<Record<string, unknown>> = [];
    lines.on("line", (line) => received.push(JSON.parse(line) as Record<string, unknown>));
    const request = (id: number, method: string, params: object = {}) =>
      child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
    const until = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for fixture: ${JSON.stringify(received)}`);
    };
    try {
      request(1, "initialize");
      request(2, "thread/start");
      await until(() => received.some((row) => row.id === 2));
      const thread = (received.find((row) => row.id === 2)?.result as { thread: { id: string } })
        .thread.id;
      request(3, "turn/start", { threadId: thread, input: [{ type: "text", text: "qa:hold" }] });
      await until(() => received.some((row) => row.id === 3));
      const turn = (received.find((row) => row.id === 3)?.result as { turn: { id: string } }).turn
        .id;
      expect(received).toContainEqual(
        expect.objectContaining({ method: "turn/started", params: expect.any(Object) }),
      );
      request(4, "turn/interrupt", { threadId: thread, turnId: turn });
      await until(() =>
        received.some(
          (row) =>
            row.method === "turn/completed" &&
            (row.params as { turn: { status: string } }).turn.status === "interrupted",
        ),
      );
      expect(received.find((row) => row.id === 4)?.result).toEqual({});
    } finally {
      child.kill();
      lines.close();
    }
  });

  it("is outside packaged files and absent from the built app bundles", () => {
    const serverPackage = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "apps/server/package.json"), "utf8"),
    ) as { files: string[] };
    expect(serverPackage.files).toEqual(["dist"]);
    expect(fs.existsSync(path.join(repoRoot, "apps/server/dist/index.mjs"))).toBe(true);
    expect(fixture.startsWith(path.join(repoRoot, "apps/server/dist"))).toBe(false);
    for (const output of ["apps/server/dist", "apps/desktop/dist", "apps/web/dist"]) {
      const root = path.join(repoRoot, output);
      if (!fs.existsSync(root)) continue;
      const visit = (dir: string) => {
        for (const name of fs.readdirSync(dir)) {
          const file = path.join(dir, name);
          const stat = fs.statSync(file);
          if (stat.isDirectory()) visit(file);
          else if (/\.(?:js|mjs|cjs)$/u.test(name))
            expect(fs.readFileSync(file, "utf8"), file).not.toContain(marker);
        }
      };
      visit(root);
    }
  });

  it("labels fixture coverage without claiming real-provider coverage", () => {
    expect(qaProviderCoverageLabel("scripted-fixture")).toBe(
      "scripted-fixture; real provider not covered",
    );
    expect(qaProviderCoverageLabel(undefined)).toBe("unverified; real provider not covered");
  });
});
