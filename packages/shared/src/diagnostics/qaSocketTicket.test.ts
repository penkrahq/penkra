import { describe, expect, it } from "vitest";
import { signQaSocketClient, verifyQaSocketClient } from "./qaSocketTicket";

const config = {
  dir: "/tmp/proofs",
  runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  secret: "ab".repeat(32),
};

describe("QA socket tickets", () => {
  it("binds a main-issued client identity to this run", () => {
    const clientId = "1".repeat(32);
    const ticketId = "3".repeat(32);
    const signature = signQaSocketClient(config, clientId, ticketId);
    expect(verifyQaSocketClient(config, clientId, ticketId, signature)).toBe(true);
    expect(verifyQaSocketClient(config, "2".repeat(32), ticketId, signature)).toBe(false);
    expect(verifyQaSocketClient(config, clientId, "4".repeat(32), signature)).toBe(false);
    expect(
      verifyQaSocketClient(
        { ...config, runId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" },
        clientId,
        ticketId,
        signature,
      ),
    ).toBe(false);
    expect(verifyQaSocketClient(config, clientId, ticketId, null)).toBe(false);
  });
});
