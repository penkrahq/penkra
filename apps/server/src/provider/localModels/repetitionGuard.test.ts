import { describe, expect, it } from "vitest";

import { forwardThinkingWithBudget } from "./localModelService.ts";
import { isLooping, RepetitionGuard } from "./repetitionGuard.ts";

describe("isLooping", () => {
  it("catches a line repeated over and over", () => {
    expect(isLooping("Let me check the file again.\n".repeat(60))).toBe(true);
  });

  it("catches a single character run", () => {
    expect(isLooping("x".repeat(1_200))).toBe(true);
  });

  it("ignores ordinary code with repeated structure", () => {
    const code = Array.from({ length: 80 }, (_, i) => `  expect(slugify("case ${i}")).toBe("case-${i}");\n`).join("");
    expect(isLooping(code)).toBe(false);
  });

  it("ignores a short repetition", () => {
    expect(isLooping("intro text. " + "ok ok ".repeat(20))).toBe(false);
  });
});

describe("RepetitionGuard", () => {
  it("fires once streamed pieces form a loop", () => {
    const guard = new RepetitionGuard();
    let fired = false;
    for (let i = 0; i < 200 && !fired; i++) fired = guard.push("export const a = 1;\n");
    expect(fired).toBe(true);
  });
});

async function* sse(deltas: ReadonlyArray<Record<string, unknown>>) {
  const encoder = new TextEncoder();
  for (const delta of deltas) yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  yield encoder.encode("data: [DONE]\n\n");
}

describe("forwardThinkingWithBudget loop guard", () => {
  it("ends a looping answer like a token limit", async () => {
    const lines: string[] = [];
    const outcome = await forwardThinkingWithBudget(
      sse([...Array.from({ length: 100 }, () => ({ content: "same line again\n" })), { content: "never sent" }]),
      (l) => lines.push(l),
      100_000,
    );
    const out = lines.join("");
    expect(outcome).toBe("looping");
    expect(out).toContain('"finish_reason":"length"');
    expect(out).toContain("[DONE]");
    expect(out).not.toContain("never sent");
  });

  it("watches tool call arguments too", async () => {
    const outcome = await forwardThinkingWithBudget(
      sse(Array.from({ length: 200 }, () => ({ tool_calls: [{ index: 0, function: { arguments: "aaaa bbbb\n" } }] }))),
      () => undefined,
      100_000,
    );
    expect(outcome).toBe("looping");
  });
});
