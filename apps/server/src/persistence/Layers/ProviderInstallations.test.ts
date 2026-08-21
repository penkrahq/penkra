import { ProviderInstallationId } from "@penkra/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProviderInstallationRepository } from "../Services/ProviderInstallations.ts";
import { ProviderInstallationRepositoryLive } from "./ProviderInstallations.ts";

const sqlLayer = NodeSqliteClient.layerMemory();
const layer = it.layer(
  Layer.mergeAll(sqlLayer, ProviderInstallationRepositoryLive.pipe(Layer.provide(sqlLayer))),
);

layer("ProviderInstallationRepository", (it) => {
  it.effect("activates one exact generation and retains the prior generation", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repository = yield* ProviderInstallationRepository;
      const base = {
        harness: "codex" as const,
        platform: "darwin",
        architecture: "arm64",
        artifactSource: "github-release",
        artifactUrl: "https://example.invalid/codex",
        artifactSha256: "a".repeat(64),
        adapterVersion: "1",
        protocolVersion: "codex-app-server-v2",
        installedAt: "2026-08-08T00:00:00.000Z",
      };
      yield* repository.activate({
        ...base,
        id: ProviderInstallationId.makeUnsafe("install-1"),
        version: "0.147.0",
        executablePath: "/managed/codex/0.147.0",
        activatedAt: "2026-08-08T00:00:00.000Z",
      });
      yield* repository.activate({
        ...base,
        id: ProviderInstallationId.makeUnsafe("install-2"),
        version: "0.148.0",
        executablePath: "/managed/codex/0.148.0",
        activatedAt: "2026-08-08T01:00:00.000Z",
      });

      const rows = yield* repository.list();
      assert.deepStrictEqual(
        rows.map((row) => [row.id, row.lifecycle]),
        [
          ["install-2", "active"],
          ["install-1", "retired"],
        ],
      );

      yield* repository.reactivate(
        ProviderInstallationId.makeUnsafe("install-1"),
        "2026-08-08T02:00:00.000Z",
      );
      const rolledBack = yield* repository.list();
      assert.deepStrictEqual(
        rolledBack.map((row) => [row.id, row.lifecycle]),
        [
          ["install-2", "retired"],
          ["install-1", "active"],
        ],
      );
    }),
  );

  it.effect("rejects reusing an installation identity for different immutable bytes", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repository = yield* ProviderInstallationRepository;
      const base = {
        id: ProviderInstallationId.makeUnsafe("install-stable"),
        harness: "codex" as const,
        version: "0.148.0",
        platform: "darwin",
        architecture: "arm64",
        executablePath: "/managed/codex/install-stable/bin/codex",
        artifactSource: "github-release",
        artifactUrl: "https://example.invalid/codex",
        artifactSha256: "a".repeat(64),
        adapterVersion: "1",
        protocolVersion: "codex-app-server-v2",
        installedAt: "2026-08-08T00:00:00.000Z",
        activatedAt: "2026-08-08T00:00:00.000Z",
      };
      yield* repository.activate(base);

      const result = yield* repository
        .activate({
          ...base,
          artifactSha256: "b".repeat(64),
          activatedAt: "2026-08-08T01:00:00.000Z",
        })
        .pipe(Effect.flip);

      assert.match(String(result), /provider installation identity collision/i);
      const rows = yield* repository.list();
      assert.deepStrictEqual(
        rows.filter((row) => row.id === "install-stable").map((row) => [row.id, row.lifecycle]),
        [["install-stable", "active"]],
      );
    }),
  );
});
