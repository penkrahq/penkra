import { describe, expect, it } from "vitest";

import { buildClaudeSubagentPrompt, parseAgentMentionInvocations } from "./agentMentions";

describe("agent mentions without shipped aliases", () => {
  it("leaves model-looking syntax as ordinary prompt text", () => {
    expect(parseAgentMentionInvocations("Check @spark(find the regression)", "codex")).toEqual([]);
  });

  it("rewrites provider-native Claude agent syntax without a shipped alias catalog", () => {
    const prompt = "Please @review(check fn(a, b)) and @explore(find callers).";
    expect(parseAgentMentionInvocations(prompt, "claudeAgent").map(({ alias }) => alias)).toEqual([
      "review",
      "explore",
    ]);
    const rewritten = buildClaudeSubagentPrompt(prompt);
    expect(rewritten.prompt).toContain('Use the "review" agent for this task:');
    expect(rewritten.prompt).toContain('Use the "explore" agent for this task:');
  });
});
