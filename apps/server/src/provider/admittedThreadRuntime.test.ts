// FILE: admittedThreadRuntime.test.ts
// Purpose: Preserve resume/reconstruction admission while the legacy reactor is removed.
// Layer: Provider runtime preparation tests

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ProviderConnectionId,
  ProviderInstallationId,
  ThreadId,
  type ProviderKind,
} from "@penkra/contracts";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, expect, it, vi } from "vitest";

import { resolveAdmittedThreadRuntime } from "./admittedThreadRuntime.ts";
import { claudeThreadTranscriptPath } from "./claudeThreadNativeState.ts";
import { providerNativeStateRoot } from "./providerNativeStatePaths.ts";
import { ProviderLaunchResolutionError } from "./Services/ProviderLaunchResolver.ts";
import type { ResolvedProviderTurnSelection } from "./Services/ProviderTurnSelectionResolver.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { createThread, upsertThreadItem } from "../cleanCore/threadStore.ts";
import { seedThreadFolderFixture } from "../cleanCore/threadFixtures.ts";

const directories: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>> = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(provider: ProviderKind, providerSessionId: string | null) {
  const scratch = join(import.meta.dirname, "../../../../.penkra/scratch");
  await mkdir(scratch, { recursive: true });
  const stateDir = await mkdtemp(join(scratch, "p30-admitted-runtime-"));
  directories.push(stateDir);
  const threadId = ThreadId.make("thread");
  const connectionId = ProviderConnectionId.make("connection");
  const installationId = ProviderInstallationId.make("installation");
  const nativeStateId = "native";
  const at = "2026-10-11T00:00:00.000Z";
  const runtime = ManagedRuntime.make(NodeSqliteClient.layerMemory());
  runtimes.push(runtime);
  const sql = await runtime.runPromise(
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedThreadFolderFixture("runtime-folder", "runtime-space");
      yield* createThread({
        id: threadId,
        provider,
        folderId: "runtime-folder",
        spaceId: "runtime-space",
        title: "Runtime",
        model: "model",
        runtimeMode: "full-access",
        createdBy: "user",
        createdAt: at,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE threads SET connection_id=${connectionId},native_state_id=${nativeStateId},provider_session_id=${providerSessionId} WHERE id=${threadId}`;
      return sql;
    }),
  );
  const selection: ResolvedProviderTurnSelection = {
    threadId,
    harness: provider,
    connectionId,
    connectionLabel: "Selected",
    previousConnectionId: connectionId,
    previousModelId: "model",
    installationId,
    internalProviderId: null,
    modelId: "model",
    modelLabel: "Model",
    nativeStateId,
    providerSessionId,
    changed: false,
    requiresNativeStateMaterialization: false,
  };
  const resolveExisting = vi.fn(() => Effect.succeed(selection));
  const resolve = vi.fn(() =>
    Effect.succeed({
      binaryPath: "/provider",
      assertCurrentCredentials: Effect.void,
      isolationKey: "isolation",
      profileRoot: join(stateDir, "profile"),
      nativeStateRoot: providerNativeStateRoot(stateDir, nativeStateId),
      connectionId,
      installationId,
      childEnvironment: (env: NodeJS.ProcessEnv) => ({ ...env, TEST_PROVIDER: "ready" }),
    }),
  );
  const input = {
    threadId,
    provider,
    modelSelection: { provider, model: "model" },
    connectionId,
  };
  const dependencies = {
    stateDir,
    sql,
    providerTurnSelectionResolver: { resolveExisting },
    providerLaunchResolver: { resolve },
  };
  return { input, dependencies, selection, resolve, resolveExisting, sql };
}

it("starts fresh without materializing when a previously connected Claude thread has no session", async () => {
  const f = await fixture("claudeAgent", null);
  const result = await Effect.runPromise(resolveAdmittedThreadRuntime(f.input, f.dependencies));
  expect(result.resumeCursor).toBeUndefined();
  expect(result.requiresReconstruction).toBe(true);
  expect(f.resolve).toHaveBeenCalledExactlyOnceWith({
    threadId: f.input.threadId,
    connectionId: f.input.connectionId,
    internalProviderId: null,
  });
  expect(result.managedLaunch.childEnvironment({ KEEP: "yes" })).toEqual({
    KEEP: "yes",
    TEST_PROVIDER: "ready",
  });
});

it.each(["codex", "claudeAgent", "opencode"] as const)(
  "rebuilds %s from canonical history after durable continuation retirement",
  async (provider) => {
    const f = await fixture(provider, "retired-native-session");
    await Effect.runPromise(
      upsertThreadItem({
        threadId: f.input.threadId,
        sourceId: "retained-history",
        turnId: null,
        kind: "text",
        status: "done",
        text: "Preserved conversation history",
        createdAt: "2026-10-11T00:00:00.000Z",
        updatedAt: "2026-10-11T00:00:00.000Z",
      }).pipe(Effect.provideService(SqlClient.SqlClient, f.sql)),
    );
    const history = await Effect.runPromise(
      f.sql`SELECT * FROM thread_items WHERE thread_id=${f.input.threadId}`,
    );
    await Effect.runPromise(
      f.sql`UPDATE threads SET provider_session_id=NULL WHERE id=${f.input.threadId} AND provider=${provider}`,
    );
    const result = await Effect.runPromise(resolveAdmittedThreadRuntime(f.input, f.dependencies));
    expect(result.resumeCursor).toBeUndefined();
    expect(result.requiresReconstruction).toBe(true);
    expect(
      await Effect.runPromise(
        f.sql`SELECT * FROM thread_items WHERE thread_id=${f.input.threadId}`,
      ),
    ).toEqual(history);
    expect(
      await Effect.runPromise(
        f.sql`SELECT connection_id, native_state_id, provider_session_id FROM threads WHERE id=${f.input.threadId}`,
      ),
    ).toEqual([
      {
        connection_id: f.selection.connectionId,
        native_state_id: f.selection.nativeStateId,
        provider_session_id: null,
      },
    ]);
  },
);

it("keeps the canonical OpenCode cursor after per-thread storage has been migrated away", async () => {
  const f = await fixture("opencode", "ses_shared");
  await mkdir(join(f.dependencies.stateDir, "profile"));
  await writeFile(
    join(f.dependencies.stateDir, "profile", "opencode.db"),
    "native database marker",
  );
  const result = await Effect.runPromise(resolveAdmittedThreadRuntime(f.input, f.dependencies));
  expect(result.requiresReconstruction).toBe(false);
  expect(result.resumeCursor).toEqual({ openCodeSessionId: "ses_shared" });
});

it("reconstructs an OpenCode conversation only when both exact storage locations are absent", async () => {
  const f = await fixture("opencode", "ses_missing");
  const result = await Effect.runPromise(resolveAdmittedThreadRuntime(f.input, f.dependencies));
  expect(result.requiresReconstruction).toBe(true);
  expect(result.resumeCursor).toBeUndefined();
});

it("rejects an ambiguously owned OpenCode conversation before preparing a process", async () => {
  const f = await fixture("opencode", "ses_shared");
  await Effect.runPromise(
    createThread({
      id: ThreadId.make("peer"),
      provider: "opencode",
      folderId: "runtime-folder",
      spaceId: "runtime-space",
      title: "Peer",
      model: "model",
      runtimeMode: "full-access",
      createdBy: "user",
      createdAt: "2026-10-11T00:00:00.000Z",
    }).pipe(Effect.provideService(SqlClient.SqlClient, f.sql)),
  );
  await Effect.runPromise(
    f.sql`UPDATE threads SET native_state_id='peer-generation',provider_session_id='ses_shared' WHERE id='peer'`,
  );
  await expect(
    Effect.runPromise(resolveAdmittedThreadRuntime(f.input, f.dependencies)),
  ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
  expect(f.resolve).not.toHaveBeenCalled();
});

it("requests transcript reconstruction when the Claude conversation is missing", async () => {
  const f = await fixture("claudeAgent", "conversation");
  const result = await Effect.runPromise(resolveAdmittedThreadRuntime(f.input, f.dependencies));
  expect(result.resumeCursor).toBeUndefined();
  expect(result.requiresReconstruction).toBe(true);
});

it("passes only the canonical Claude session id when conversation files exist", async () => {
  const f = await fixture("claudeAgent", "conversation");
  const cursor = { resume: "conversation" };
  const path = claudeThreadTranscriptPath(
    f.dependencies.stateDir,
    f.selection.nativeStateId!,
    "conversation",
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ type: "assistant", message: { content: "prior answer" } })}\n`,
  );
  const result = await Effect.runPromise(resolveAdmittedThreadRuntime(f.input, f.dependencies));
  expect(result.resumeCursor).toEqual(cursor);
  expect(result.requiresReconstruction).toBe(false);
});

it("refuses an unadmitted Connection change before preparing a process", async () => {
  const f = await fixture("codex", "conversation");
  f.resolveExisting.mockImplementation(() => Effect.succeed({ ...f.selection, changed: true }));
  await expect(
    Effect.runPromise(resolveAdmittedThreadRuntime(f.input, f.dependencies)),
  ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
  expect(f.resolve).not.toHaveBeenCalled();
});

it("refuses native state changed after admission before preparing a process", async () => {
  const f = await fixture("codex", "conversation");
  await Effect.runPromise(
    f.sql`UPDATE threads SET native_state_id='changed' WHERE id=${f.input.threadId}`,
  );
  await expect(
    Effect.runPromise(resolveAdmittedThreadRuntime(f.input, f.dependencies)),
  ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
  expect(f.resolve).not.toHaveBeenCalled();
});

it("uses the supplied provider for invalid admission instead of guessing Codex", async () => {
  const f = await fixture("opencode", null);
  await expect(
    Effect.runPromise(
      resolveAdmittedThreadRuntime({ ...f.input, connectionId: undefined }, f.dependencies),
    ),
  ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError", provider: "opencode" });
  expect(f.resolveExisting).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
});

it("preserves the launch failure as the validation error cause", async () => {
  const f = await fixture("codex", null);
  const cause = new ProviderLaunchResolutionError({ detail: "fixture launch failure" });
  const dependencies = {
    ...f.dependencies,
    providerLaunchResolver: { resolve: () => Effect.fail(cause) },
  };
  await expect(
    Effect.runPromise(resolveAdmittedThreadRuntime(f.input, dependencies)),
  ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError", cause });
});
