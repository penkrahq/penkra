import { describe, expect, it } from "vitest";

import type { PenkraTodoSummary } from "@penkra/contracts";
import { composePenkraTodoPrompt, penkraProjectId, resolvePenkraTodoProvider } from "./invoke";

const todo: PenkraTodoSummary = {
  id: "todo-1",
  clientId: "client-1",
  programId: "program-1",
  source: "operator",
  kind: "renewal",
  title: "Draft renewal notice",
  status: "open",
  execution: "agent",
  dueAt: null,
  payload: { instructions: "Use the current fee schedule." },
  blockedReason: null,
  provider: null,
  model: null,
  auto: false,
  operatorTouched: false,
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
  doneAt: null,
  skillRef: "client-drafting",
  defaultProvider: "codex",
  defaultModel: null,
  programLabel: "Annual renewal",
};

describe("Penkra todo invocation", () => {
  it("composes scoped skill, instructions, program, and completion guidance", () => {
    const prompt = composePenkraTodoPrompt(todo);
    expect(prompt).toContain("$client-drafting");
    expect(prompt).toContain("Use the current fee schedule.");
    expect(prompt).toContain("Annual renewal (id program-1)");
    expect(prompt).toContain("penkra todo done todo-1");
  });

  it("accepts supported providers and rejects unknown provider names", () => {
    expect(resolvePenkraTodoProvider(todo)).toBe("codex");
    expect(resolvePenkraTodoProvider({ ...todo, defaultProvider: "unknown" })).toBeUndefined();
    expect(penkraProjectId("client-1")).toBe("penkra-client-client-1");
  });
});
