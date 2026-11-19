import { describe, expect, it } from "vitest";

import {
  forwardThinkingWithBudget,
  mergeSystemMessages,
  moveEnvironmentToUser,
} from "./localModelService.ts";

describe("mergeSystemMessages", () => {
  it("folds every system message into one leading message", () => {
    expect(
      mergeSystemMessages([
        { role: "system", content: "a" },
        { role: "user", content: "hi" },
        { role: "system", content: [{ type: "text", text: "b" }] },
        { role: "assistant", content: "yo" },
      ]),
    ).toEqual([
      { role: "system", content: "a\n\nb" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
  });

  it("leaves conversations without system messages alone", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(mergeSystemMessages(messages)).toEqual(messages);
  });
});

async function* sse(deltas: ReadonlyArray<Record<string, string>>) {
  const encoder = new TextEncoder();
  for (const delta of deltas)
    yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  yield encoder.encode("data: [DONE]\n\n");
}

describe("forwardThinkingWithBudget", () => {
  it("forwards a short stream whole", async () => {
    const lines: string[] = [];
    const over = await forwardThinkingWithBudget(
      sse([{ reasoning: "hmm" }, { content: "Hi" }]),
      (l) => lines.push(l),
      100,
    );
    expect(over).toBe("done");
    expect(lines.join("")).toContain("[DONE]");
  });

  it("stops once reasoning passes the budget", async () => {
    const lines: string[] = [];
    const over = await forwardThinkingWithBudget(
      sse([{ reasoning: "x".repeat(60) }, { reasoning: "y".repeat(60) }, { content: "late" }]),
      (l) => lines.push(l),
      100,
    );
    expect(over).toBe("over-budget");
    expect(lines.join("")).not.toContain("late");
    expect(lines.join("")).not.toContain("[DONE]");
  });
});

describe("moveEnvironmentToUser", () => {
  it("moves the per-thread env block into the first user message", () => {
    expect(
      moveEnvironmentToUser([
        { role: "system", content: "intro\n<env>\n  cwd: /a\n</env>\nskills" },
        { role: "user", content: "hi" },
      ]),
    ).toEqual([
      { role: "system", content: "intro\nskills" },
      { role: "user", content: "<env>\n  cwd: /a\n</env>\n\nhi" },
    ]);
  });

  it("leaves prompts without an env block alone", () => {
    const messages = [{ role: "system", content: "x" }, { role: "user", content: "hi" }];
    expect(moveEnvironmentToUser(messages)).toEqual(messages);
  });
});
