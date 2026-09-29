import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { qaProviderCoverageLabel } from "../diagnostics-qa-gate";
import { assertIsolatedQaStateDir, seedScriptedProvider } from "./seed-scripted-provider.mjs";

const fixture = fileURLToPath(new URL("./scripted-codex-app-server.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const marker = "PENKRA_QA_SCRIPTED_PROVIDER_FIXTURE_V1";

describe("scripted provider QA fixture", () => {
  it("serves a real JSONL app-server process and completes or interrupts turns", async () => {
    const fixtureHome = fs.mkdtempSync("/tmp/penkra-diagnostics-qa-codex-home.");
    const child = spawn(process.execPath, [fixture, "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: fixtureHome },
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
      request(5, "account/read");
      request(6, "model/list");
      request(2, "thread/start");
      await until(() => received.some((row) => row.id === 5));
      expect(received.find((row) => row.id === 5)?.result).toEqual({
        account: { type: "chatgpt", email: "qa-fixture@example.invalid" },
      });
      await until(() => received.some((row) => row.id === 6));
      expect(received.find((row) => row.id === 6)?.result).toMatchObject({
        data: [{ id: "qa-fixture-model", isDefault: true }],
      });
      await until(() => received.some((row) => row.id === 2));
      const thread = (received.find((row) => row.id === 2)!.result as { thread: { id: string } })
        .thread.id;
      const rolloutRoot = path.join(fixtureHome, "sessions");
      const rollouts = fs
        .readdirSync(rolloutRoot, { recursive: true })
        .filter((name) => String(name).endsWith(`-${thread}.jsonl`));
      expect(rollouts).toHaveLength(1);
      request(3, "turn/start", { threadId: thread, input: [{ type: "text", text: "qa:hold" }] });
      await until(() => received.some((row) => row.id === 3));
      const turn = (received.find((row) => row.id === 3)!.result as { turn: { id: string } }).turn
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
      fs.rmSync(fixtureHome, { recursive: true, force: true });
    }
  });

  it("resumes a fixture thread after its app-server process restarts", async () => {
    const fixtureHome = fs.mkdtempSync("/tmp/penkra-diagnostics-qa-codex-home.");
    const threadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const sessions = path.join(fixtureHome, "sessions", "2026", "09", "29");
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, `rollout-2026-09-29T00-00-00-${threadId}.jsonl`), "{}\n");
    const child = spawn(process.execPath, [fixture, "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: fixtureHome },
    });
    const lines = createInterface({ input: child.stdout! });
    try {
      const result = new Promise<Record<string, unknown>>((resolve) => {
        lines.on("line", (line) => resolve(JSON.parse(line) as Record<string, unknown>));
      });
      child.stdin!.write(
        `${JSON.stringify({ id: 1, method: "thread/resume", params: { threadId } })}\n`,
      );
      expect(await result).toMatchObject({ id: 1, result: { thread: { id: threadId } } });
    } finally {
      child.kill();
      lines.close();
      fs.rmSync(fixtureHome, { recursive: true, force: true });
    }
  });

  it("is outside packaged files and absent from the built app bundles", () => {
    const serverPackage = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "apps/server/package.json"), "utf8"),
    ) as { files: string[] };
    expect(serverPackage.files).toEqual(["dist"]);
    expect(fs.existsSync(path.join(repoRoot, "apps/server/dist/index.mjs"))).toBe(true);
    expect(fixture.startsWith(path.join(repoRoot, "apps/server/dist"))).toBe(false);
    // build-desktop-artifact stages dist-electron into the packaged app.
    for (const output of ["apps/server/dist", "apps/desktop/dist-electron", "apps/web/dist"]) {
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
  }, 30_000);

  it("compiles the QA account guard false in the staged desktop bundle", () => {
    const bundled = fs.readFileSync(
      path.join(repoRoot, "apps/desktop/dist-electron/main.js"),
      "utf8",
    );
    expect(/function diagnosticsQaShellEnabled\(\)\s*\{\s*return false;\s*\}/u.test(bundled)).toBe(
      true,
    );
  });

  it("compiles fixture launch permission off in the staged server bundle", () => {
    const serverBundle = fs.readFileSync(path.join(repoRoot, "apps/server/dist/index.mjs"), "utf8");
    expect(serverBundle).toContain("buildEnabled: false");
    expect(serverBundle).not.toContain("buildEnabled: true");
  });

  it("labels fixture coverage without claiming real-provider coverage", () => {
    expect(qaProviderCoverageLabel("scripted-fixture")).toBe(
      "scripted-fixture; real provider not covered",
    );
    expect(qaProviderCoverageLabel(undefined)).toBe("unverified; real provider not covered");
  });

  it("seeds only a fresh, disposable Dev provider catalog", () => {
    expect(() => assertIsolatedQaStateDir(repoRoot)).toThrow(/disposable/);
    const root = fs.mkdtempSync("/tmp/penkra-diagnostics-qa-0143.");
    const stateDir = path.join(root, "dev");
    fs.mkdirSync(stateDir);
    const desktopStateDir = path.join(root, "root", ".penkra", "userdata");
    fs.mkdirSync(desktopStateDir, { recursive: true });
    expect(assertIsolatedQaStateDir(desktopStateDir)).toBe(fs.realpathSync(desktopStateDir));
    const developmentStateDir = path.join(root, "root", ".penkra", "dev");
    fs.mkdirSync(developmentStateDir);
    expect(assertIsolatedQaStateDir(developmentStateDir)).toBe(
      fs.realpathSync(developmentStateDir),
    );
    const db = new DatabaseSync(path.join(stateDir, "state.sqlite"));
    try {
      db.exec(`
        CREATE TABLE provider_installations (
          installation_id TEXT, harness_kind TEXT, version TEXT, platform TEXT,
          architecture TEXT, executable_path TEXT, artifact_source TEXT,
          artifact_url TEXT, artifact_sha256 TEXT, adapter_version TEXT,
          protocol_version TEXT, lifecycle TEXT, installed_at TEXT, activated_at TEXT
        );
        CREATE TABLE provider_connections (
          connection_id TEXT, harness_kind TEXT, authentication_target_id TEXT,
          authentication_method_id TEXT, label TEXT, profile_ref TEXT,
          health_status TEXT, lifecycle TEXT, created_at TEXT, updated_at TEXT
        );
      `);
      db.prepare(
        "INSERT INTO provider_installations (installation_id, harness_kind) VALUES (?, ?)",
      ).run("auto-discovered-dev-installation", "codex");
    } finally {
      db.close();
    }
    try {
      expect(seedScriptedProvider(stateDir).fixture).toBe(fixture);
      expect(() => seedScriptedProvider(stateDir)).toThrow(/fresh Dev provider catalog/);
      const read = new DatabaseSync(path.join(stateDir, "state.sqlite"));
      try {
        expect(read.prepare("SELECT COUNT(*) AS n FROM provider_installations").get()?.n).toBe(1);
        expect(read.prepare("SELECT COUNT(*) AS n FROM provider_connections").get()?.n).toBe(1);
        const binary = read.prepare("SELECT executable_path FROM provider_installations").get()
          ?.executable_path as string;
        expect(binary).toBe(
          path.join(
            path.resolve(stateDir),
            "provider-runtimes",
            "codex",
            "versions",
            "1.0.0",
            "bin",
            "codex.mjs",
          ),
        );
        expect(fs.readFileSync(binary, "utf8")).toContain(marker);
        const activation = JSON.parse(
          fs.readFileSync(
            path.join(stateDir, "provider-runtimes", "codex", "activation.json"),
            "utf8",
          ),
        ) as { active: { installationId: string } };
        expect(activation.active.installationId).toBe("qa-scripted-codex-installation");
      } finally {
        read.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked state database before opening it", () => {
    const root = fs.mkdtempSync("/tmp/penkra-diagnostics-qa-0143.");
    const stateDir = path.join(root, "dev");
    fs.mkdirSync(stateDir);
    const target = path.join(root, "target.sqlite");
    fs.writeFileSync(target, "outside database");
    fs.symlinkSync(target, path.join(stateDir, "state.sqlite"));
    try {
      expect(() => seedScriptedProvider(stateDir)).toThrow(/non-symlinked/);
      expect(fs.readFileSync(target, "utf8")).toBe("outside database");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
