import { describe, expect, it } from "vitest";

import {
  getAgentMentionAliases,
  getAgentMentionAutocompleteAliases,
  isValidAgentAlias,
  resolveAgentAlias,
} from "./agentMentions";

describe("agentMentions", () => {
  it("does not ship model- or agent-name aliases", () => {
    expect(getAgentMentionAutocompleteAliases("codex")).toEqual([]);
    expect(getAgentMentionAutocompleteAliases("claudeAgent")).toEqual([]);
    expect(getAgentMentionAutocompleteAliases("opencode")).toEqual([]);
    expect(getAgentMentionAliases()).toEqual([]);
  });

  it("does not resolve retired built-in aliases", () => {
    expect(resolveAgentAlias("mini", "codex")).toBeNull();
    expect(resolveAgentAlias("review", "claudeAgent")).toBeNull();
    expect(isValidAgentAlias("spark", "codex")).toBe(false);
  });
});
