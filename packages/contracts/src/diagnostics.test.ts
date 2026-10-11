import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DiagnosticTraceContext } from "./diagnostics";

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
});
