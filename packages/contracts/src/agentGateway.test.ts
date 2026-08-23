import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  PenkraCapabilitiesResult,
  PenkraCreateThreadInput,
  PenkraCreateThreadResult,
  PenkraGatewayErrorResult,
  PenkraWaitForThreadsInput,
  PenkraWaitForThreadsResult,
} from "./agentGateway";

const decodeCreate = Schema.decodeUnknownSync(PenkraCreateThreadInput);
const decodeWait = Schema.decodeUnknownSync(PenkraWaitForThreadsInput);

const thread = {
  prompt: "Explain this repository",
  target: {
    provider: "codex",
    model: "gpt-5.6-terra",
    options: { reasoningEffort: "low" },
  },
} as const;

describe("agent gateway contracts", () => {
  it("accepts one exact creation request", () => {
    assert.deepEqual(decodeCreate({ requestId: "request-1", ...thread }).target, thread.target);
  });

  it("requires a bounded request id", () => {
    assert.throws(() => decodeCreate({ requestId: "", ...thread }));
    assert.throws(() => decodeCreate({ requestId: "x".repeat(257), ...thread }));
  });

  it("rejects removed Git environment creation fields", () => {
    assert.throws(() =>
      decodeCreate({
        requestId: "removed-git-fields",
        ...thread,
        environment: "worktree",
        baseRef: "0123456789abcdef",
      }),
    );
  });

  it("decodes provider-specific model options without folding them into the slug", () => {
    const decoded = decodeCreate({ requestId: "terra-low", ...thread });
    assert.deepEqual(decoded.target, thread.target);
    assert.throws(() =>
      decodeCreate({
        requestId: "cross-provider-options",
        prompt: "invalid",
        target: {
          provider: "claudeAgent",
          model: "claude-sonnet-5",
          options: { reasoningEffort: "low" },
        },
      }),
    );
  });

  it("bounds wait targets and timeout", () => {
    assert.equal(decodeWait({ threadIds: ["thread-1"], timeoutMs: 60_000 }).timeoutMs, 60_000);
    assert.throws(() => decodeWait({ threadIds: [] }));
    assert.throws(() => decodeWait({ threadIds: ["thread-1"], timeoutMs: 60_001 }));
  });

  it("decodes typed capability, creation, wait, and error results", () => {
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(PenkraCapabilitiesResult)({
        targetConstruction: {
          codex: {
            modelValueSource: "providers[].models[].slug",
            primaryOptionKey: "reasoningEffort",
            alternativeOptionKeys: [],
            optionSelectionRule: "Use the model-specific rules when present.",
            providerOptions: [
              {
                key: "reasoningEffort",
                valueType: "string",
                allowedValues: ["low", "medium", "high"],
                allowedValuesSource: "provider-contract",
              },
            ],
            optionsByModel: {
              "gpt-5.5": [
                {
                  key: "reasoningEffort",
                  valueType: "string",
                  allowedValues: ["low", "high"],
                  allowedValuesSource: "model-discovery",
                },
              ],
            },
            exampleTarget: {
              provider: "codex",
              model: "gpt-5.5",
              options: { reasoningEffort: "low" },
            },
          },
        },
        providers: [
          {
            provider: "codex",
            defaultModel: "gpt-5.5",
            models: [{ slug: "gpt-5.5", name: "GPT-5.5" }],
            enabled: true,
            available: true,
            authStatus: "authenticated",
          },
        ],
        limits: {
          maxThreadsPerWait: 20,
          maxWaitMs: 60_000,
        },
      }),
    );
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(PenkraCreateThreadResult)({
        operationId: "gateway:create:1",
        requestId: "request-1",
        threadId: "thread-1",
        folderId: "project-1",
        title: "Worker",
        target: thread.target,
        provider: "codex",
        model: "gpt-5.6-terra",
        runtimeMode: "approval-required",
        status: "task_dispatched",
      }),
    );
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(PenkraWaitForThreadsResult)({
        callerThreadId: "thread-parent",
        runIds: ["turn-1"],
        allTerminal: true,
        timedOut: false,
        threads: [
          {
            threadId: "thread-1",
            runId: "turn-1",
            state: "completed",
            terminal: true,
            timedOut: false,
            summary: "Done",
            summaryTruncated: false,
            error: null,
            readThread: {
              tool: "penkra_read_thread",
              arguments: { threadId: "thread-1" },
            },
          },
        ],
      }),
    );
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(PenkraGatewayErrorResult)({
        error: { code: "operation_failed", message: "Creation failed." },
      }),
    );
  });
});
