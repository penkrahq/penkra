import { describe, expect, it } from "vitest";

import { decodeCreateThreadInput, decodeSendMessageInput, ToolInputError } from "./toolInput";

describe("strict gateway input admission", () => {
  const target = { provider: "codex", model: "gpt-5.6-terra", options: { reasoningEffort: "low" } };

  it("accepts the same exact selection for creation and sending", () => {
    expect(
      decodeCreateThreadInput({ requestId: "request-1", prompt: "Review this", target }).target,
    ).toEqual(target);
    expect(
      decodeSendMessageInput({ threadId: "thread-1", message: "Continue", modelSelection: target })
        .modelSelection,
    ).toEqual(target);
  });

  it("rejects obsolete top-level fields at the actual gateway decoder", () => {
    expect(() =>
      decodeCreateThreadInput({
        requestId: "request-1",
        prompt: "Review this",
        target,
        environment: "worktree",
      }),
    ).toThrow(ToolInputError);
    expect(() =>
      decodeSendMessageInput({ threadId: "thread-1", message: "Continue", extra: true }),
    ).toThrow(ToolInputError);
  });

  it("rejects another provider's option inside the selection", () => {
    const invalid = {
      provider: "claudeAgent",
      model: "opus-4.8",
      options: { reasoningEffort: "low" },
    };
    expect(() =>
      decodeCreateThreadInput({ requestId: "request-1", prompt: "Review this", target: invalid }),
    ).toThrow(ToolInputError);
    expect(() =>
      decodeSendMessageInput({
        threadId: "thread-1",
        message: "Continue",
        modelSelection: invalid,
      }),
    ).toThrow(ToolInputError);
  });
});
