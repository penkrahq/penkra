import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@penkra/contracts";
import { it, assert } from "@effect/vitest";
import { assertFailure, assertSome } from "@effect/vitest/utils";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ProviderSessionDirectoryPersistenceError } from "../Errors.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

it.layer(ProviderSessionDirectoryLive)("ProviderSessionDirectoryLive", (it) => {
  it("upserts, reads, and removes thread bindings", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionDirectory;

      const initialThreadId = ThreadId.make("thread-1");

      yield* directory.upsert({
        provider: "codex",
        threadId: initialThreadId,
      });

      const provider = yield* directory.getProvider(initialThreadId);
      assert.equal(provider, "codex");
      const resolvedBinding = yield* directory.getBinding(initialThreadId);
      if (Option.isSome(resolvedBinding)) {
        assert.equal(resolvedBinding.value.threadId, initialThreadId);
      }

      const nextThreadId = ThreadId.make("thread-2");

      yield* directory.upsert({
        provider: "codex",
        threadId: nextThreadId,
      });
      const updatedBinding = yield* directory.getBinding(nextThreadId);
      assert.equal(Option.isSome(updatedBinding), true);
      if (Option.isSome(updatedBinding)) {
        assert.equal(updatedBinding.value.threadId, nextThreadId);
      }

      const runtime = yield* runtimeRepository.getBinding(nextThreadId);
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, nextThreadId);
        assert.equal(runtime.value.provider, "codex");
      }

      const threadIds = yield* directory.listThreadIds();
      assert.deepEqual(threadIds, [initialThreadId, nextThreadId]);

      yield* directory.remove(nextThreadId);
      const missingProvider = yield* directory.getProvider(nextThreadId).pipe(Effect.result);
      assertFailure(
        missingProvider,
        new ProviderSessionDirectoryPersistenceError({
          operation: "ProviderSessionDirectory.getProvider",
          detail: `No live provider binding found for thread '${nextThreadId}'.`,
        }),
      );
    }));

  it("tracks live runtime fields and merges payload updates", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionDirectory;

      const threadId = ThreadId.make("thread-runtime");

      yield* directory.upsert({
        provider: "codex",
        threadId,
        status: "starting",
        resumeCursor: {
          threadId: "provider-thread-runtime",
        },
        runtimePayload: {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
        },
      });

      yield* directory.upsert({
        provider: "codex",
        threadId,
        status: "running",
        runtimePayload: {
          activeTurnId: "turn-1",
        },
      });

      const runtime = yield* runtimeRepository.getBinding(threadId);
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, threadId);
        assert.deepEqual(runtime.value.resumeCursor, {
          threadId: "provider-thread-runtime",
        });
        assert.deepEqual(runtime.value.runtimePayload, {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
          activeTurnId: "turn-1",
        });
      }
    }));

  it("resets adapterKey to the new provider when provider changes without an explicit adapter key", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionDirectory;
      const threadId = ThreadId.make("thread-provider-change");

      yield* runtimeRepository.upsert({
        threadId,
        provider: "claudeAgent",
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lifecycleGeneration: "legacy-test-claude",
        lastSeenAt: new Date().toISOString(),
        resumeCursor: null,
        runtimePayload: null,
      });

      yield* directory.upsert({
        provider: "codex",
        threadId,
      });

      const runtime = yield* runtimeRepository.getBinding(threadId);
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.provider, "codex");
        assert.equal(runtime.value.adapterKey, "codex");
      }
    }));
});
