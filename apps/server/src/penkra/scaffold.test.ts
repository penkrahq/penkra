import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, it } from "@effect/vitest";

import { resolvePenkraRuntimeConfig } from "./config";
import { withPenkraProviderEnv } from "./providerEnv";
import { hasClientConfig, scaffoldClient, scaffoldHq } from "./scaffold";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Penkra workspace scaffolding", () => {
  it("writes client config atomically with restrictive permissions", async () => {
    const root = await temporaryRoot();
    const workspace = await scaffoldClient({
      root,
      endpoint: "https://api.penkra.com",
      client: {
        id: "11111111-1111-4111-8111-111111111111",
        displayName: "Example Client",
        status: "active",
      },
      token: "pk_client_example",
      instructions: "# Client instructions\n",
    });
    const configPath = path.join(workspace, ".penkra", "config.json");
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(parsed.clientId, "11111111-1111-4111-8111-111111111111");
    assert.equal(parsed.displayName, "Example Client");
    assert.equal((await stat(path.dirname(configPath))).mode & 0o777, 0o700);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal(await hasClientConfig(workspace, parsed.clientId), true);
  });

  it("materializes identical HQ guidance for Codex and Claude without mtime churn", async () => {
    const root = await temporaryRoot();
    const workspace = await scaffoldHq(root, "# Penkra HQ\n");
    const agentsPath = path.join(workspace, "AGENTS.md");
    const claudePath = path.join(workspace, "CLAUDE.md");
    assert.equal(await readFile(agentsPath, "utf8"), "# Penkra HQ\n");
    assert.equal(await readFile(claudePath, "utf8"), "# Penkra HQ\n");
    const before = (await stat(agentsPath)).mtimeMs;
    await scaffoldHq(root, "# Penkra HQ\n");
    assert.equal((await stat(agentsPath)).mtimeMs, before);
  });

  it("refuses to create blank instruction materializations", async () => {
    const root = await temporaryRoot();
    await assert.rejects(scaffoldHq(root, ""), /Refusing to scaffold blank Penkra instructions/);
    await assert.rejects(readFile(path.join(root, "hq", "AGENTS.md"), "utf8"), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(path.join(root, "hq", "CLAUDE.md"), "utf8"), {
      code: "ENOENT",
    });
  });
});

describe("Penkra runtime configuration", () => {
  it("resolves root, endpoint, and HQ config location", () => {
    assert.deepEqual(
      resolvePenkraRuntimeConfig({
        PENKRA_ROOT: "/tmp/Penkra",
        PENKRA_API_URL: "https://staging.penkra.com/",
      }),
      {
        root: "/tmp/Penkra",
        endpoint: "https://staging.penkra.com",
        hqConfigPath: "/tmp/Penkra/hq/.penkra/config.json",
      },
    );
    assert.equal(resolvePenkraRuntimeConfig({}), null);
  });

  it("adds the workspace config and thread correlation without injecting loose credentials", async () => {
    const root = await temporaryRoot();
    const workspace = await scaffoldClient({
      root,
      endpoint: "https://api.penkra.com",
      client: {
        id: "22222222-2222-4222-8222-222222222222",
        displayName: "Provider Client",
        status: "active",
      },
      token: "pk_client_provider",
      instructions: "# Client instructions\n",
    });
    const env = withPenkraProviderEnv(
      {
        PATH: "/bin",
        PENKRA_CONFIG: "/tmp/wrong-scope.json",
        PENKRA_ENDPOINT: "https://wrong-scope.invalid",
        PENKRA_SESSION_ID: "wrong-thread",
        PENKRA_TOKEN: "must-not-survive",
      },
      {
        workspace,
        threadId: "thread-1",
      },
    );
    assert.equal(env.PENKRA_CONFIG, path.join(workspace, ".penkra", "config.json"));
    assert.equal(env.PENKRA_SESSION_ID, "thread-1");
    assert.equal(env.PENKRA_ENDPOINT, undefined);
    assert.equal(env.PENKRA_TOKEN, undefined);
  });

  it("does not expose inherited Penkra scope when the active workspace has no config", async () => {
    const workspace = await temporaryRoot();
    const env = withPenkraProviderEnv(
      {
        PENKRA_CONFIG: "/tmp/wrong-scope.json",
        PENKRA_ENDPOINT: "https://wrong-scope.invalid",
        PENKRA_TOKEN: "must-not-survive",
      },
      {
        workspace,
        threadId: "thread-2",
      },
    );
    assert.equal(env.PENKRA_CONFIG, undefined);
    assert.equal(env.PENKRA_ENDPOINT, undefined);
    assert.equal(env.PENKRA_TOKEN, undefined);
    assert.equal(env.PENKRA_SESSION_ID, "thread-2");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "penkra-scaffold-"));
  roots.push(root);
  return root;
}
