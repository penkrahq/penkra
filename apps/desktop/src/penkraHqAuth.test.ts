import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, it } from "vitest";

import { authenticateAndStorePenkraHq } from "./penkraHqAuth";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Penkra HQ authentication", () => {
  it("stores only the issued token with restrictive permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "penkra-hq-auth-"));
    roots.push(root);
    const configPath = path.join(root, "hq", ".penkra", "config.json");
    const result = await authenticateAndStorePenkraHq({
      endpoint: "https://api.penkra.com/",
      password: "secret",
      configPath,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            token: "pk_hq_example",
            scope: "hq",
            clientId: null,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    });
    assert.deepEqual(result, { ok: true });
    const contents = await readFile(configPath, "utf8");
    assert.doesNotMatch(contents, /secret/);
    assert.match(contents, /pk_hq_example/);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(configPath))).mode & 0o777, 0o700);
  });

  it("does not write a config after uniform authentication failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "penkra-hq-auth-"));
    roots.push(root);
    const result = await authenticateAndStorePenkraHq({
      endpoint: "https://api.penkra.com",
      password: "wrong",
      configPath: path.join(root, "hq", ".penkra", "config.json"),
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: "Authentication failed" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    assert.deepEqual(result, { ok: false, message: "Authentication failed." });
  });
});
