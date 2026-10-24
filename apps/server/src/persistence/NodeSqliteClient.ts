/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import { createHash } from "node:crypto";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

import {
  isFatalSqliteDatabaseError,
  isSqliteCorruptionError,
  isSqliteIoError,
} from "./SqliteSafety.ts";

export { isSqliteCorruptionError, isSqliteIoError } from "./SqliteSafety.ts";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

/**
 * Bounded-query target from the 0.14.4 clean-core design: every query should
 * finish under 50 ms on the Production copy. Statements at or above this log a
 * warning with the query text so the offender can be found and fixed at its
 * root cause (missing index, unbounded scan, or wrong data shape).
 */
const SLOW_STATEMENT_TARGET_MS = 50;

export const TypeId: TypeId = "~local/sqlite-node/SqliteClient";

export type TypeId = "~local/sqlite-node/SqliteClient";

/**
 * SqliteClient - Effect service tag for the sqlite SQL client.
 */
export const SqliteClient = Context.Service<Client.SqlClient>(
  "penkra/persistence/NodeSqliteClient",
);

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
  /** Called once when SQLite reports connection-invalidating corruption or I/O failure. */
  readonly onFatalError?: ((cause: unknown) => void) | undefined;
}

export interface SqliteMemoryClientConfig extends Omit<
  SqliteClientConfig,
  "filename" | "readonly"
> {}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      `Node.js ${process.versions.node} is missing required node:sqlite APIs ` +
        `(StatementSync.columns). Upgrade to Node.js >=22.16, >=23.11, or >=24.`,
    );
  }
  return Effect.void;
};

const makeWithDatabase = (
  options: SqliteClientConfig,
  openDatabase: () => DatabaseSync,
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  Effect.gen(function* () {
    yield* checkNodeSqliteCompat();

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined;

    const makeConnection = Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const db = openDatabase();
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => db.close()),
      );

      const statementReaderCache = new WeakMap<StatementSync, boolean>();
      let fatalSqlError: SqlError | null = null;
      const makeSqlError = (cause: unknown, message: string): SqlError => {
        if (fatalSqlError !== null) return fatalSqlError;
        const error = new SqlError({ reason: classifySqliteError(cause, { message }) });
        if (isFatalSqliteDatabaseError(cause)) {
          fatalSqlError = error;
          options.onFatalError?.(cause);
        }
        return error;
      };
      const hasRows = (statement: StatementSync): boolean => {
        const cached = statementReaderCache.get(statement);
        if (cached !== undefined) {
          return cached;
        }
        const value = statement.columns().length > 0;
        statementReaderCache.set(statement, value);
        return value;
      };
      const reportSlowStatement = (
        sql: string,
        parameterCount: number,
        startedAt: number,
        phase: "prepare" | "execute" = "execute",
      ): void => {
        const durationMs = Math.round(performance.now() - startedAt);
        if (durationMs < SLOW_STATEMENT_TARGET_MS) return;
        console.warn("[sqlite] query exceeded the bounded-query target", {
          ownerFiberId: Fiber.getCurrent()?.id ?? null,
          phase,
          query: sql.replaceAll(/\s+/gu, " ").trim().slice(0, 300),
          queryHash: createHash("sha256").update(sql).digest("hex").slice(0, 16),
          parameterCount,
          durationMs,
          targetMs: SLOW_STATEMENT_TARGET_MS,
          completedAtUtc: new Date().toISOString(),
        });
      };
      const prepareStatement = (sql: string): StatementSync => {
        const startedAt = performance.now();
        try {
          return db.prepare(sql);
        } finally {
          reportSlowStatement(sql, 0, startedAt, "prepare");
        }
      };

      // Prepared statements belong to this connection and expire when it closes.
      const preparedStatements = new Map<string, StatementSync>();
      const getPreparedStatement = (sql: string) =>
        Effect.try({
          try: () => {
            const existing = preparedStatements.get(sql);
            if (existing !== undefined) return existing;
            const statement = prepareStatement(sql);
            preparedStatements.set(sql, statement);
            return statement;
          },
          catch: (cause) => makeSqlError(cause, `Failed to prepare statement: ${sql}`),
        });

      const runStatement = (
        sql: string,
        statement: StatementSync,
        params: ReadonlyArray<unknown>,
        raw: boolean,
      ) =>
        Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
          if (fatalSqlError !== null) return Effect.fail(fatalSqlError);
          statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
          const startedAt = performance.now();
          try {
            if (hasRows(statement)) {
              return Effect.succeed(statement.all(...(params as any)));
            }
            const result = statement.run(...(params as any));
            return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : []);
          } catch (cause) {
            return Effect.fail(makeSqlError(cause, `Failed to execute statement: ${sql}`));
          } finally {
            reportSlowStatement(sql, params.length, startedAt);
          }
        });

      const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
        Effect.flatMap(getPreparedStatement(sql), (s) => runStatement(sql, s, params, raw));

      const runValues = (sql: string, params: ReadonlyArray<unknown>, prepared = true) =>
        Effect.acquireUseRelease(
          prepared
            ? getPreparedStatement(sql)
            : Effect.try({
                try: () => prepareStatement(sql),
                catch: (cause) => makeSqlError(cause, `Failed to prepare statement: ${sql}`),
              }),
          (statement) =>
            Effect.try({
              try: () => {
                if (fatalSqlError !== null) throw fatalSqlError;
                const startedAt = performance.now();
                try {
                  if (hasRows(statement)) {
                    statement.setReturnArrays(true);
                    // Safe to cast to array after we've setReturnArrays(true)
                    return statement.all(...(params as any)) as unknown as ReadonlyArray<
                      ReadonlyArray<unknown>
                    >;
                  }
                  statement.run(...(params as any));
                  return [];
                } finally {
                  reportSlowStatement(sql, params.length, startedAt);
                }
              },
              catch: (cause) => makeSqlError(cause, `Failed to execute statement: ${sql}`),
            }),
          (statement) =>
            Effect.sync(() => {
              if (hasRows(statement)) {
                statement.setReturnArrays(false);
              }
            }),
        );

      return identity<Connection>({
        execute(sql, params, rowTransform) {
          return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
        },
        executeRaw(sql, params) {
          return run(sql, params, true);
        },
        executeValues(sql, params) {
          return runValues(sql, params);
        },
        executeValuesUnprepared(sql, params) {
          return runValues(sql, params, false);
        },
        executeUnprepared(sql, params, rowTransform) {
          // SQLITE_FULL, IOERR and NOMEM can roll back the entire transaction,
          // including its savepoints. There is then nothing for Effect's rollback
          // finalizer to undo; running it would replace the original SQL error.
          if (
            (sql === "ROLLBACK" || sql.startsWith("ROLLBACK TO SAVEPOINT effect_sql_")) &&
            !db.isTransaction
          ) {
            return Effect.succeed([]);
          }
          const effect = Effect.flatMap(
            Effect.try({
              try: () => prepareStatement(sql),
              catch: (cause) => makeSqlError(cause, `Failed to prepare statement: ${sql}`),
            }),
            (statement) => runStatement(sql, statement, params ?? [], false),
          );
          return rowTransform ? Effect.map(effect, rowTransform) : effect;
        },
        executeStream(_sql, _params) {
          return Stream.die("executeStream not implemented");
        },
      });
    });

    const semaphore = yield* Semaphore.make(1);
    const connection = yield* makeConnection;

    const acquirer = Effect.suspend(() => {
      const startedAt = performance.now();
      return semaphore.withPermits(1)(
        Effect.sync(() => {
          return connection;
        }),
      );
    });
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!;
      const scope = Context.getUnsafe(fiber.context, Scope.Scope);
      const waitStartedAt = performance.now();
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () => {
          const acquiredAt = performance.now();
          const acquiredAtUtc = new Date().toISOString();
          return Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              const elapsedMs = performance.now() - acquiredAt;
              return Math.round(elapsedMs);
            }).pipe(
              Effect.ensuring(semaphore.release(1)),
              Effect.flatMap((holdMs) =>
                holdMs < 5_000
                  ? Effect.void
                  : Effect.logWarning("sqlite transaction held connection").pipe(
                      Effect.annotateLogs({
                        ownerFiberId: fiber.id,
                        acquiredAtUtc,
                        releasedAtUtc: new Date().toISOString(),
                        waitMs: Math.round(acquiredAt - waitStartedAt),
                        holdMs,
                      }),
                    ),
              ),
            ),
          );
        }),
        connection,
      );
    });

    return yield* Client.make({
      driver: "@penkra/node-sqlite",
      acquirer,
      compiler,
      transactionAcquirer,
      spanAttributes: [
        ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
        [ATTR_DB_SYSTEM_NAME, "sqlite"],
      ],
      transformRows,
    });
  });

const make = (
  options: SqliteClientConfig,
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    options,
    () =>
      new DatabaseSync(options.filename, {
        readOnly: options.readonly ?? false,
        allowExtension: options.allowExtension ?? false,
      }),
  );

const makeMemory = (
  config: SqliteMemoryClientConfig = {},
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    {
      ...config,
      filename: ":memory:",
      readonly: false,
    },
    () => {
      const database = new DatabaseSync(":memory:", {
        allowExtension: config.allowExtension ?? false,
      });
      return database;
    },
  );

export const layerConfig = (
  config: Config.Wrap<SqliteClientConfig>,
): Layer.Layer<Client.SqlClient, Config.ConfigError> =>
  Layer.effectContext(
    Config.unwrap(config).pipe(
      Effect.flatMap(make),
      Effect.map((client) =>
        Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
      ),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(make(config), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layerMemory = (config: SqliteMemoryClientConfig = {}): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(makeMemory(config), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));
