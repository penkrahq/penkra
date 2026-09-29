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
const fixtureVersion = "1.0.0";

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
  const realDir = assertIsolatedQaStateDir(stateDir);
  // Keep the spelling used by ServerConfig. On macOS /tmp resolves to
  // /private/tmp, but installation executable_path is an immutable identity.
  const dir = path.resolve(stateDir);
  const databasePath = path.join(dir, "state.sqlite");
  if (!fs.existsSync(databasePath))
    throw new Error("Start and stop the Dev server to migrate first");
  if (
    fs.lstatSync(databasePath).isSymbolicLink() ||
    fs.realpathSync(databasePath) !== path.join(realDir, "state.sqlite")
  )
    throw new Error("Fixture seeding requires a non-symlinked Dev database");
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
    // Register a managed generation as well. Otherwise the normal provider
    // bootstrap retires the fixture row and installs a real Codex binary.
    const runtimeRoot = path.join(dir, "provider-runtimes", "codex");
    const versionDir = path.join(runtimeRoot, "versions", fixtureVersion);
    const executable = path.join(versionDir, "bin", "codex.mjs");
    if (fs.existsSync(versionDir)) throw new Error("Fixture generation already exists");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(fixture, executable);
    fs.chmodSync(executable, 0o700);
    fs.writeFileSync(
      path.join(versionDir, "managed-runtime.json"),
      JSON.stringify({
        schemaVersion: 1,
        provider: "codex",
        installationId: installId,
        version: fixtureVersion,
        platform: process.platform,
        architecture: process.arch,
        adapterVersion: "1",
        protocolVersion: "codex-app-server-v2",
        executableRelativePath: "bin/codex.mjs",
        installedAt: now,
        artifact: {
          source: "qa-fixture",
          metadataUrl: `file://${fixture}`,
          url: `file://${fixture}`,
          assetName: "scripted-codex-app-server.mjs",
          sha256: digest,
          integrity: "verified",
        },
      }),
    );
    fs.writeFileSync(
      path.join(runtimeRoot, "activation.json"),
      JSON.stringify({
        schemaVersion: 2,
        provider: "codex",
        active: {
          installationId: installId,
          version: fixtureVersion,
          executableRelativePath: "bin/codex.mjs",
          activatedAt: now,
        },
        previous: null,
        rejected: null,
      }),
    );
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
      executable,
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
