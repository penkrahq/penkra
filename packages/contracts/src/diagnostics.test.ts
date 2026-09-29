import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DiagnosticTraceContext } from "./diagnostics";
import { DispatchCommandRpcInput } from "./orchestration";

const command = {
  type: "thread.turn.interrupt",
  commandId: "command-1",
  threadId: "thread-1",
  createdAt: "2026-09-28T12:00:00.000Z",
};

describe("diagnostic trace protocol", () => {
  it("accepts a valid W3C trace and rejects content in trace identifiers", () => {
    const diagnostics = { traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef" };
    expect(Schema.decodeUnknownSync(DiagnosticTraceContext)(diagnostics)).toEqual(diagnostics);
    expect(() =>
      Schema.decodeUnknownSync(DiagnosticTraceContext)({
        ...diagnostics,
        traceId: "message content",
      }),
    ).toThrow();
  });

  it("accepts traced commands and legacy bare commands during update rollout", () => {
    const diagnostics = { traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef" };
    expect(Schema.decodeUnknownSync(DispatchCommandRpcInput)(command)).toMatchObject(command);
    expect(
      Schema.decodeUnknownSync(DispatchCommandRpcInput)({ command, diagnostics }),
    ).toMatchObject({ command, diagnostics });
  });
});
