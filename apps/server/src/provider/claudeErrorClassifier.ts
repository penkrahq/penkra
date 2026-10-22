import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRuntimeTurnStatus } from "@penkra/contracts";
import { Cause } from "effect";
import type { ProcessExitHandle } from "./supervisedProcessTeardown.ts";

function messages(cause: Cause.Cause<Error>): ReadonlyArray<string> {
  return Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter(Boolean);
}

export function messageFromClaudeStreamCause(cause: Cause.Cause<Error>, fallback: string): string {
  return messages(cause)[0] ?? fallback;
}

const interruptionMessages = new Set([
  "All fibers interrupted without error",
  "Request was aborted.",
  "Interrupted by user",
]);

export function isClaudeInterruptedCause(cause: Cause.Cause<Error>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    messages(cause).some((message) => interruptionMessages.has(message))
  );
}

export function interruptionMessageFromClaudeCause(cause: Cause.Cause<Error>): string {
  const message = messageFromClaudeStreamCause(cause, "Claude runtime interrupted.");
  return interruptionMessages.has(message) ? "Claude runtime interrupted." : message;
}

export const CLAUDE_BENIGN_TERMINATION_MESSAGE =
  "Claude runtime stopped and will resume on your next message.";

export function isClaudeBenignTerminationCause(
  cause: Cause.Cause<Error>,
  process?: Pick<ProcessExitHandle, "exitCode" | "signalCode">,
): boolean {
  if (process?.signalCode != null)
    return process.signalCode === "SIGINT" || process.signalCode === "SIGTERM";
  if (process?.exitCode != null) return process.exitCode === 130 || process.exitCode === 143;
  return messages(cause).some((message) =>
    /^Claude Code process exited with code (130|143)$/.test(message),
  );
}

export function isClaudeMissingResumeConversationCause(cause: Cause.Cause<Error>): boolean {
  return messages(cause).some((message) =>
    /^(?:Claude Code returned an error result: )?No conversation found with session ID: \S+$/.test(
      message,
    ),
  );
}

export function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.terminal_reason === "aborted_streaming" || result.terminal_reason === "aborted_tools")
    return "interrupted";
  return result.subtype === "success" && !result.is_error ? "completed" : "failed";
}

/** Presentation-only filtering; never used to select a lifecycle outcome. */
export function sanitizeClaudeDisplayText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.trim().toLowerCase();
      return !(
        normalized.startsWith("[ede_diagnostic]") &&
        normalized.includes("result_type=") &&
        normalized.includes("stop_reason=")
      );
    })
    .join("\n");
}

export function normalizeClaudeUserVisibleErrorMessage(
  text: string | undefined,
  status: ProviderRuntimeTurnStatus,
): string | undefined {
  if (typeof text !== "string") return undefined;
  const sanitized = sanitizeClaudeDisplayText(text).trim();
  if (sanitized.length === 0) return undefined;
  if (sanitized === "User interrupted response.")
    return status === "interrupted" ? "Claude runtime interrupted." : undefined;
  if (/^[\]})"'`.,;:!?_-]+$/.test(sanitized))
    return status === "interrupted" ? "Claude runtime interrupted." : "Claude turn failed.";
  return sanitized;
}
