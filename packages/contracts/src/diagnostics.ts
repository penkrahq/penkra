import { Schema } from "effect";

/** W3C Trace Context identifiers; retry identity is separate from command identity. */
export const DiagnosticTraceContext = Schema.Struct({
  traceId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u)),
  spanId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/u)),
  parentSpanId: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/u))),
  attemptId: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/u))),
});
export type DiagnosticTraceContext = typeof DiagnosticTraceContext.Type;
