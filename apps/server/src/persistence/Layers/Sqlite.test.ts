import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { makeSqlitePersistenceLive } from "./Sqlite.ts";

const tempDirectories: Array<string> = [];

function queryFromSeparateProcess(dbPath: string, statement: string) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(process.argv[1], { readOnly: true });
try {
  database.prepare(process.argv[2]).get();
  process.stdout.write("query-succeeded");
} finally {
  database.close();
}`,
      dbPath,
      statement,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
}

async function makeDbPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "penkra-sqlite-live-"));
  tempDirectories.push(directory);
  return path.join(directory, "state.sqlite");
}

async function createNormalWalSnapshot(dbPath: string): Promise<Buffer> {
  const seedPath = `${dbPath}.seed`;
  const seed = new DatabaseSync(seedPath);
  try {
    seed.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE recovery_probe(value TEXT NOT NULL);
    `);
    seed.prepare("INSERT INTO recovery_probe(value) VALUES (?)").run("survives-recovery");
    await Promise.all(
      ["", "-wal", "-shm"].map((suffix) =>
        fs.copyFile(`${seedPath}${suffix}`, `${dbPath}${suffix}`),
      ),
    );
    return fs.readFile(`${dbPath}-shm`);
  } finally {
    seed.close();
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

describe("SQLite persistence", () => {
  it("owns the live WAL exclusively without exposing a shared-memory sidecar", async () => {
    const dbPath = await makeDbPath();

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [lockingMode] = yield* sql<{ readonly locking_mode: string }>`
          PRAGMA locking_mode;
        `;
        const [journalMode] = yield* sql<{ readonly journal_mode: string }>`
          PRAGMA journal_mode;
        `;

        expect(lockingMode?.locking_mode).toBe("exclusive");
        expect(journalMode?.journal_mode).toBe("wal");

        yield* sql`CREATE TABLE ownership_probe(value TEXT NOT NULL)`;
        yield* sql`INSERT INTO ownership_probe(value) VALUES ('owned-by-penkra')`;
        yield* Effect.promise(async () => {
          await expect(fs.stat(`${dbPath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
        });

        const external = queryFromSeparateProcess(dbPath, "SELECT value FROM ownership_probe");
        expect(external.status).not.toBe(0);
        expect(external.stderr).toMatch(/database is locked/i);

        const rows = yield* sql<{ readonly value: string }>`
          SELECT value FROM ownership_probe
        `;
        expect(rows).toEqual([{ value: "owned-by-penkra" }]);
        yield* Effect.promise(async () => {
          await expect(fs.stat(`${dbPath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
        });
      }).pipe(
        Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
      ),
    );
  });

  it("recovers an existing WAL without touching its stale shared-memory sidecar", async () => {
    const dbPath = await makeDbPath();
    const staleShm = await createNormalWalSnapshot(dbPath);

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly value: string }>`
          SELECT value FROM recovery_probe
        `;
        const [lockingMode] = yield* sql<{ readonly locking_mode: string }>`
          PRAGMA locking_mode;
        `;

        expect(rows).toEqual([{ value: "survives-recovery" }]);
        expect(lockingMode?.locking_mode).toBe("exclusive");
        yield* Effect.promise(async () => {
          expect(await fs.readFile(`${dbPath}-shm`)).toEqual(staleShm);
        });
      }).pipe(
        Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
      ),
    );

    expect(await fs.readFile(`${dbPath}-shm`)).toEqual(staleShm);
  });

  it("retains cross-process ownership through repeated restart cycles", async () => {
    const dbPath = await makeDbPath();

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            CREATE TABLE IF NOT EXISTS restart_probe(
              cycle INTEGER PRIMARY KEY NOT NULL
            )
          `;
          yield* sql`INSERT INTO restart_probe(cycle) VALUES (${cycle})`;

          const external = queryFromSeparateProcess(dbPath, "SELECT COUNT(*) FROM restart_probe");
          expect(external.status).not.toBe(0);
          expect(external.stderr).toMatch(/database is locked/i);
        }).pipe(
          Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
        ),
      );

      const offline = queryFromSeparateProcess(dbPath, "SELECT COUNT(*) FROM restart_probe");
      expect(offline.status).toBe(0);
      expect(offline.stdout).toBe("query-succeeded");
    }

    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM restart_probe").get()).toMatchObject({
        count: 3,
      });
    } finally {
      database.close();
    }
  });
});
