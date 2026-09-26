import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  PenkraCapabilitiesResult,
  PenkraCreateThreadInput,
  PenkraCreateThreadResult,
  PenkraGatewayErrorResult,
  PenkraSendMessageInput,
} from "./agentGateway";
import { ThreadId } from "./baseSchemas";

const decodeCreate = Schema.decodeUnknownSync(PenkraCreateThreadInput);
const decodeSend = Schema.decodeUnknownSync(PenkraSendMessageInput);

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

  it("accepts an exact send selection and preserves explicit anonymous routing", () => {
    const modelSelection = {
      provider: "codex",
      model: "gpt-5.6-terra",
      options: { reasoningEffort: "low" },
    } as const;
    const threadId = ThreadId.makeUnsafe("thread-1");
    assert.deepEqual(
      decodeSend({
        threadId,
        message: "Continue the review.",
        now: true,
        connectionId: null,
        modelSelection,
      }),
      {
        threadId,
        message: "Continue the review.",
        now: true,
        connectionId: null,
        modelSelection,
      },
    );
  });

  it("rejects malformed and unexpected send selection fields", () => {
    assert.throws(() => decodeSend({ threadId: "thread-1", message: "" }));
    assert.throws(() => decodeSend({ threadId: "thread-1", message: "go", extra: true }));
    assert.throws(() =>
      decodeSend({
        threadId: "thread-1",
        message: "go",
        modelSelection: { provider: "claudeAgent", model: "opus-4.8", options: { invalid: true } },
      }),
    );
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

  it("decodes typed capability, creation, and error results", () => {
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
        messageId: "message-1",
        turnId: "turn-1",
      }),
    );
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(PenkraGatewayErrorResult)({
        error: { code: "operation_failed", message: "Creation failed." },
      }),
    );
  });
});
