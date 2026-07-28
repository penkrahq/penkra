import { describe, expect, it } from "vitest";

import { sanitizeTerminalOutput } from "./sanitizeTerminalOutput.ts";

describe("sanitizeTerminalOutput", () => {
  it("removes terminal controls and preserves the actionable failure", () => {
    const output =
      "\u001b[999D\u001b[JUpgrading...\r\u001b[999D\u001b[Jnpm error EEXIST: file already exists";

    expect(sanitizeTerminalOutput(output)).toBe(
      "Upgrading...\nnpm error EEXIST: file already exists",
    );
  });
});
