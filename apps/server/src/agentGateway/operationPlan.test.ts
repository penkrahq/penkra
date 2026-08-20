import { describe, expect, it } from "vitest";

import {
  parseRecoverableCreationPlan,
  redactCreationPlanForPurgedCaller,
} from "./operationPlan.ts";

describe("agent gateway operation plans", () => {
  const planJson = JSON.stringify([
    {
      spec: { prompt: "private caller prompt" },
      projectId: "private-project",
      ids: {
        threadId: "agent:child",
        compensateCommandId: "agent:child:delete",
      },
    },
  ]);

  it("retains only deterministic compensation ids during caller purge", () => {
    const redacted = redactCreationPlanForPurgedCaller({
      planJson,
      operationId: "gateway:create:child",
    });
    expect(JSON.parse(redacted)).toEqual([
      {
        ids: {
          threadId: "agent:child",
          compensateCommandId: "agent:child:delete",
        },
      },
    ]);
    expect(redacted).not.toContain("private caller prompt");
    expect(redacted).not.toContain("private-project");
  });

  it("rejects plans without deterministic compensation ids", () => {
    expect(() => parseRecoverableCreationPlan("[{}]", "gateway:create:invalid")).toThrow(
      "has no deterministic ids",
    );
  });
});
