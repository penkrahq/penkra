import { describe, expect, it } from "vitest";

import { collectTailTurnIds } from "./conversationRollback";

describe("conversationRollback", () => {
  it("collects unique turn ids from a target message through the tail", () => {
    expect(
      collectTailTurnIds({
        messages: [
          { id: "m1", turnId: "turn-1" },
          { id: "m2", turnId: null },
          { id: "m3", turnId: "turn-2" },
          { id: "m4", turnId: "turn-2" },
        ],
        messageId: "m2",
      }),
    ).toEqual(["turn-2"]);
  });
});
