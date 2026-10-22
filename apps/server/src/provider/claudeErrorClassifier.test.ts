import { describe, expect, it } from "vitest";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { Cause, Effect } from "effect";
import {
  isClaudeBenignTerminationCause,
  isClaudeInterruptedCause,
  isClaudeMissingResumeConversationCause,
  sanitizeClaudeDisplayText,
  turnStatusFromResult,
} from "./claudeErrorClassifier.ts";

describe("Claude error classification", () => {
  it.each(["aborted_streaming", "aborted_tools"] as const)(
    "uses native terminal reason %s",
    (terminal_reason) => {
      expect(
        turnStatusFromResult({
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason,
        } as SDKResultMessage),
      ).toBe("interrupted");
    },
  );

  it.each(["Failed to interrupt the remote worker", "The cancel operation failed"])(
    "does not infer lifecycle from %s",
    (detail) => {
      expect(
        turnStatusFromResult({
          subtype: "error_during_execution",
          is_error: true,
          errors: [detail],
        } as SDKResultMessage),
      ).toBe("failed");
    },
  );

  it("distinguishes a successful envelope from successful work", () => {
    expect(turnStatusFromResult({ subtype: "success", is_error: true } as SDKResultMessage)).toBe(
      "failed",
    );
    expect(turnStatusFromResult({ subtype: "success", is_error: false } as SDKResultMessage)).toBe(
      "completed",
    );
  });

  it("recognizes the real Effect interrupt after runPromise squashes it", async () => {
    const error = await Effect.runPromise(Effect.interrupt).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(isClaudeInterruptedCause(Cause.fail(error as Error))).toBe(true);
    expect(
      isClaudeInterruptedCause(
        Cause.fail(new Error("Remote log says: All fibers interrupted without error")),
      ),
    ).toBe(false);
  });

  it("prefers owned process exit facts to SDK text", () => {
    const cause = Cause.fail(new Error("Claude Code process exited with code 143"));
    expect(isClaudeBenignTerminationCause(cause, { exitCode: 137, signalCode: null })).toBe(false);
    expect(isClaudeBenignTerminationCause(cause, { exitCode: null, signalCode: "SIGTERM" })).toBe(
      true,
    );
    expect(isClaudeBenignTerminationCause(cause)).toBe(true);
    expect(
      isClaudeBenignTerminationCause(Cause.fail(new Error("Remote tool exited with code 143"))),
    ).toBe(false);
  });

  it("only recognizes the exact missing native conversation envelope", () => {
    expect(
      isClaudeMissingResumeConversationCause(
        Cause.fail(new Error("No conversation found with session ID: native-id")),
      ),
    ).toBe(true);
    expect(
      isClaudeMissingResumeConversationCause(
        Cause.fail(new Error("Remote tool: no conversation found with session id native-id")),
      ),
    ).toBe(false);
  });

  it("keeps diagnostic removal presentation-only", () => {
    expect(
      sanitizeClaudeDisplayText("Hello\n[ede_diagnostic] result_type=user stop_reason=null\nWorld"),
    ).toBe("Hello\nWorld");
    expect(sanitizeClaudeDisplayText("[ede_diagnostic] incomplete")).toBe(
      "[ede_diagnostic] incomplete",
    );
  });
});
