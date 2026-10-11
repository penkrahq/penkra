// FILE: admittedThreadRuntime.test.ts
// Purpose: Preserve resume/reconstruction admission while the legacy reactor is removed.
// Layer: Provider runtime preparation tests

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ProviderConnectionId,
  ProviderInstallationId,
  ProviderNativeStateGenerationId,
  ThreadId,
  type ProviderKind,
} from "@penkra/contracts";
import { Effect, Option } from "effect";
import { afterEach, expect, it, vi } from "vitest";

import { resolveAdmittedThreadRuntime } from "./admittedThreadRuntime.ts";
import { claudeThreadTranscriptPath } from "./claudeThreadNativeState.ts";
import { ProviderLaunchResolutionError } from "./Services/ProviderLaunchResolver.ts";
import type { ResolvedProviderTurnSelection } from "./Services/ProviderTurnSelectionResolver.ts";
import type { ThreadHarnessStateRecord } from "../persistence/Services/ThreadProviderBindings.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(provider: ProviderKind, providerSessionId: string | null) {
  const stateDir = await mkdtemp(join(tmpdir(), "penkra-admitted-runtime-"));
  directories.push(stateDir);
  const threadId = ThreadId.makeUnsafe("thread");
  const connectionId = ProviderConnectionId.makeUnsafe("connection");
  const installationId = ProviderInstallationId.makeUnsafe("installation");
  const nativeStateGenerationId = ProviderNativeStateGenerationId.makeUnsafe("native");
  const at = "2026-10-11T00:00:00.000Z";
  const state: ThreadHarnessStateRecord = {
    threadId,
    harness: provider,
    nativeStateGenerationId,
    providerSessionId,
    nativeStateLocatorJson: JSON.stringify(
      providerSessionId === null ? null : { resume: providerSessionId },
    ),
    lastVerifiedResumeAt: null,
    revision: 2,
    createdAt: at,
    updatedAt: at,
  };
  const selection: ResolvedProviderTurnSelection = {
    threadId,
    harness: provider,
    connectionId,
    connectionLabel: "Selected",
    previousConnectionId: connectionId,
    previousModelId: "model",
    previousInstallationId: installationId,
    installationId,
    internalProviderId: null,
    modelId: "model",
    modelLabel: "Model",
    stateRevision: 2,
    bindingRevision: 3,
    changed: false,
    requiresNativeStateMaterialization: false,
  };
  const resolveExisting = vi.fn(() => Effect.succeed(selection));
  const getHarnessState = vi.fn(() => Effect.succeed(Option.some(state)));
  const resolve = vi.fn(() =>
    Effect.succeed({
      binaryPath: "/provider",
      isolationKey: "isolation",
      profileRoot: "/profile",
      nativeStateRoot: "/native",
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
    bindingRevision: 3,
  };
  const dependencies = {
    stateDir,
    threadProviderBindings: { getHarnessState },
    providerTurnSelectionResolver: { resolveExisting },
    providerLaunchResolver: { resolve },
  };
  return { input, dependencies, state, selection, resolve, resolveExisting, getHarnessState };
}

it("starts fresh without materializing when a previously connected Claude thread has no session", async () => {
  const f = await fixture("claudeAgent", null);
  const result = await Effect.runPromise(resolveAdmittedThreadRuntime(f.input, f.dependencies));
  expect(result.resumeCursor).toBeUndefined();
  expect(result.requiresReconstruction).toBe(false);
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

it("requests transcript reconstruction when the Claude conversation is missing", async () => {
  const f = await fixture("claudeAgent", "conversation");
  const result = await Effect.runPromise(resolveAdmittedThreadRuntime(f.input, f.dependencies));
  expect(result.resumeCursor).toBeUndefined();
  expect(result.requiresReconstruction).toBe(true);
});

it("passes the exact Claude resume cursor and its held task metadata when conversation files exist", async () => {
  const f = await fixture("claudeAgent", "conversation");
  const cursor = {
    resume: "conversation",
    resumeSessionAt: "assistant-uuid",
    turnCount: 4,
    trackedTasks: [{ taskId: "task", status: "running" }],
  };
  f.getHarnessState.mockImplementation(() =>
    Effect.succeed(Option.some({ ...f.state, nativeStateLocatorJson: JSON.stringify(cursor) })),
  );
  const path = claudeThreadTranscriptPath(
    f.dependencies.stateDir,
    f.state.nativeStateGenerationId,
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
  f.getHarnessState.mockImplementation(() =>
    Effect.succeed(Option.some({ ...f.state, revision: 4 })),
  );
  await expect(
    Effect.runPromise(resolveAdmittedThreadRuntime(f.input, f.dependencies)),
  ).rejects.toMatchObject({ _tag: "ProviderAdapterValidationError" });
  expect(f.resolve).not.toHaveBeenCalled();
});

it("refuses malformed resume data before preparing a process", async () => {
  const f = await fixture("codex", "conversation");
  f.getHarnessState.mockImplementation(() =>
    Effect.succeed(Option.some({ ...f.state, nativeStateLocatorJson: "{" })),
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
