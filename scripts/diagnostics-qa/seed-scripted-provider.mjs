#!/usr/bin/env node
// Run only against a stopped, disposable diagnostics QA Dev instance.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const fixture = fileURLToPath(new URL("./scripted-codex-app-server.mjs", import.meta.url));
const installId = "qa-scripted-codex-installation";
const connectionId = "qa-scripted-codex-connection";

export function assertIsolatedQaStateDir(stateDir) {
  const resolved = fs.realpathSync(stateDir);
  const tmpRoot = fs.realpathSync("/tmp");
  const relative = path.relative(tmpRoot, resolved).split(path.sep);
  if (
    !/^penkra-diagnostics-qa-0143\.[A-Za-z0-9]+$/u.test(relative[0] ?? "") ||
    !(
      (relative.length === 2 && relative[1] === "dev") ||
      (relative.length === 4 &&
        relative[1] === "root" &&
        relative[2] === ".penkra" &&
        ["userdata", "dev"].includes(relative[3]))
    )
  )
    throw new Error(
      "Fixture seeding requires a disposable diagnostics QA Dev directory under /tmp",
    );
  return resolved;
}

export function seedScriptedProvider(stateDir) {
  const dir = assertIsolatedQaStateDir(stateDir);
  const databasePath = path.join(dir, "state.sqlite");
  if (!fs.existsSync(databasePath))
    throw new Error("Start and stop the Dev server to migrate first");
  const db = new DatabaseSync(databasePath, { timeout: 1000 });
  try {
    db.exec("BEGIN IMMEDIATE");
    const connections = db.prepare("SELECT COUNT(*) AS n FROM provider_connections").get().n;
    if (connections !== 0) throw new Error("Fixture seeding requires a fresh Dev provider catalog");
    // The first Dev boot may auto-discover a local Codex binary. Replace that
    // installation in this disposable catalog so only the fixture is selectable.
    db.exec("DELETE FROM provider_installations");
    const now = new Date().toISOString();
    const digest = createHash("sha256").update(fs.readFileSync(fixture)).digest("hex");
    db.prepare(`
      INSERT INTO provider_installations (
        installation_id, harness_kind, version, platform, architecture,
        executable_path, artifact_source, artifact_url, artifact_sha256,
        adapter_version, protocol_version, lifecycle, installed_at, activated_at
      ) VALUES (?, 'codex', '1.0.0', ?, ?, ?, 'qa-fixture', ?, ?,
                '1', 'codex-app-server-v2', 'active', ?, ?)
    `).run(
      installId,
      process.platform,
      process.arch,
      fixture,
      `file://${fixture}`,
      digest,
      now,
      now,
    );
    db.prepare(`
      INSERT INTO provider_connections (
        connection_id, harness_kind, authentication_target_id, authentication_method_id,
        label, profile_ref, health_status, lifecycle, created_at, updated_at
      ) VALUES (?, 'codex', 'openai-first-party', 'chatgpt',
                'Scripted QA fixture', 'provider-profile:qa-scripted-provider',
                'ready', 'active', ?, ?)
    `).run(connectionId, now, now);
    db.exec("COMMIT");
    return { installId, connectionId, fixture };
  } catch (cause) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The opening transaction may have failed before it was active.
    }
    throw cause;
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stateDir = process.argv[2];
  if (!stateDir) throw new Error("Usage: seed-scripted-provider.mjs <isolated-dev-state-dir>");
  process.stdout.write(`${JSON.stringify(seedScriptedProvider(stateDir))}\n`);
}
