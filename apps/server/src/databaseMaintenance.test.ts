import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { runDatabaseMaintenanceCli } from "./databaseMaintenance.ts";
import {
  acquireDatabaseLifecycleLock,
  releaseDatabaseLifecycleLock,
} from "./persistence/DatabaseLifecycleLock.ts";

function makeDatabase(): { readonly directory: string; readonly dbPath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-database-maintenance-"));
  const dbPath = path.join(directory, "state.sqlite");
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(`
      CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE threads(id TEXT PRIMARY KEY);
      CREATE TABLE thread_items(thread_id TEXT,seq INTEGER,data TEXT);
      INSERT INTO effect_sql_migrations VALUES (1,'Initial');
    `);
  } finally {
    database.close();
  }
  return { directory, dbPath };
}

function captureOutput() {
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    output: {
      error: (message: string) => errors.push(message),
      log: (message: string) => logs.push(message),
    },
    errors,
    logs,
  };
}

describe("offline database maintenance CLI", () => {
  it("ships the lifecycle-aware database command from the bundled server package", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly bin?: Record<string, string> };

    expect(packageJson.bin?.["penkra-database"]).toBe("dist/databaseMaintenance.mjs");
  });

  it("verifies a coherent Penkra database while it is offline", async () => {
    const fixture = makeDatabase();
    const capture = captureOutput();
    try {
      expect(await runDatabaseMaintenanceCli(["verify", fixture.dbPath], capture.output)).toBe(0);
      expect(capture.errors).toEqual([]);
      expect(capture.logs.join("\n")).toContain('"status": "ok"');
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("reports physical storage, row counts, and reclaimable pages", async () => {
    const fixture = makeDatabase();
    const capture = captureOutput();
    try {
      expect(
        await runDatabaseMaintenanceCli(["report", fixture.dbPath], capture.output),
        capture.errors.join("\n"),
      ).toBe(0);
      const report = JSON.parse(capture.logs.join("\n")) as {
        readonly mainFileBytes: number;
        readonly pageCount: number;
        readonly rowCounts: Record<string, number>;
        readonly payloadBytes: Record<string, number>;
        readonly orchestrationEventCounts: Record<string, number>;
        readonly commandReceiptCounts: Record<string, number>;
      };
      expect(report.mainFileBytes).toBeGreaterThan(0);
      expect(report.pageCount).toBeGreaterThan(0);
      expect(report.rowCounts.effect_sql_migrations).toBe(1);
      expect(report.rowCounts.thread_items).toBe(0);
      expect(report.payloadBytes.effect_sql_migrations).toBeGreaterThan(0);
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("builds a verified compact candidate without mutating the source", async () => {
    const fixture = makeDatabase();
    const candidatePath = path.join(fixture.directory, "state.compact.sqlite");
    const database = new DatabaseSync(fixture.dbPath);
    try {
      database.exec(
        `INSERT INTO threads VALUES ('thread-1'); INSERT INTO thread_items VALUES ('thread-1',1,'{}'),('thread-1',2,'{}');`,
      );
    } finally {
      database.close();
    }
    const capture = captureOutput();
    try {
      expect(
        await runDatabaseMaintenanceCli(["compact", fixture.dbPath, candidatePath], capture.output),
      ).toBe(0);
      const report = JSON.parse(capture.logs.join("\n")) as {
        semanticTableHashes: Record<string, string>;
      };
      expect(report.semanticTableHashes.threads).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.existsSync(candidatePath)).toBe(true);
      const source = new DatabaseSync(fixture.dbPath, { readOnly: true });
      try {
        expect(source.prepare("SELECT COUNT(*) AS value FROM thread_items").get()?.value).toBe(2);
      } finally {
        source.close();
      }
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("cuts over a verified candidate and retains the original rollback artifact", async () => {
    const fixture = makeDatabase();
    const candidatePath = path.join(fixture.directory, "state.compact.sqlite");
    const rollbackPath = `${fixture.dbPath}.pre-cutover.sqlite`;
    const database = new DatabaseSync(fixture.dbPath);
    try {
      database.exec(
        `INSERT INTO threads VALUES ('thread-1'); INSERT INTO thread_items VALUES ('thread-1',1,'{}'),('thread-1',2,'{}');`,
      );
    } finally {
      database.close();
    }
    try {
      const compactCapture = captureOutput();
      expect(
        await runDatabaseMaintenanceCli(
          ["compact", fixture.dbPath, candidatePath],
          compactCapture.output,
        ),
        compactCapture.errors.join("\n"),
      ).toBe(0);

      const cutoverCapture = captureOutput();
      expect(
        await runDatabaseMaintenanceCli(
          ["cutover", fixture.dbPath, candidatePath],
          cutoverCapture.output,
        ),
        cutoverCapture.errors.join("\n"),
      ).toBe(0);
      const report = JSON.parse(cutoverCapture.logs.join("\n")) as {
        readonly rollbackPath: string;
      };
      expect(report.rollbackPath).toBe(rollbackPath);
      expect(fs.existsSync(candidatePath)).toBe(false);
      expect(fs.existsSync(rollbackPath)).toBe(true);

      const selected = new DatabaseSync(fixture.dbPath, { readOnly: true });
      const rollback = new DatabaseSync(rollbackPath, { readOnly: true });
      try {
        expect(selected.prepare("SELECT COUNT(*) AS value FROM thread_items").get()?.value).toBe(2);
        expect(rollback.prepare("SELECT COUNT(*) AS value FROM thread_items").get()?.value).toBe(2);
      } finally {
        selected.close();
        rollback.close();
      }
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("discards a semantically invalid cutover candidate and leaves the source selected", async () => {
    const fixture = makeDatabase();
    const candidatePath = path.join(fixture.directory, "state.invalid.sqlite");
    const source = new DatabaseSync(fixture.dbPath);
    try {
      source.exec(`VACUUM INTO '${candidatePath.replaceAll("'", "''")}'`);
    } finally {
      source.close();
    }
    const candidate = new DatabaseSync(candidatePath);
    try {
      candidate.exec("INSERT INTO threads VALUES ('unexpected-thread')");
    } finally {
      candidate.close();
    }
    const capture = captureOutput();
    try {
      expect(
        await runDatabaseMaintenanceCli(["cutover", fixture.dbPath, candidatePath], capture.output),
      ).toBe(1);
      expect(capture.errors.join("\n")).toContain("changed canonical data");
      expect(fs.existsSync(candidatePath)).toBe(false);
      expect(fs.existsSync(fixture.dbPath)).toBe(true);
      expect(fs.existsSync(`${fixture.dbPath}.pre-cutover.sqlite`)).toBe(false);
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("refuses verification while a Penkra lifecycle owner is live", async () => {
    const fixture = makeDatabase();
    const capture = captureOutput();
    const lock = await Effect.runPromise(acquireDatabaseLifecycleLock(fixture.dbPath));
    try {
      expect(await runDatabaseMaintenanceCli(["verify", fixture.dbPath], capture.output)).toBe(1);
      expect(capture.errors.join("\n")).toContain("DatabaseLifecycleLockedError");
      expect(capture.logs).toEqual([]);
    } finally {
      await Effect.runPromise(releaseDatabaseLifecycleLock(lock));
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("rejects a physically corrupt database", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-database-corrupt-"));
    const dbPath = path.join(directory, "state.sqlite");
    const capture = captureOutput();
    fs.writeFileSync(dbPath, Buffer.alloc(4_096));
    try {
      expect(await runDatabaseMaintenanceCli(["verify", dbPath], capture.output)).toBe(1);
      expect(capture.errors.join("\n")).toMatch(/not a database|malformed/u);
      expect(capture.logs).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
