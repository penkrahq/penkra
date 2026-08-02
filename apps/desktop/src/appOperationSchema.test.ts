import { describe, expect, it } from "vitest";

import {
  APP_OPERATION_VALUE_MAX_DEPTH,
  assertOperationValue,
  compileOperationValidators,
} from "./appOperationSchema";

const declaration = {
  key: "issues.create",
  summary: "Create an issue.",
  handler: "issues.create",
  input: {
    type: "object",
    required: ["title"],
    properties: { title: { type: "string", minLength: 1 } },
    additionalProperties: false,
  },
  output: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
    additionalProperties: false,
  },
} as const;

describe("App operation schema boundary", () => {
  it("compiles once-ready validators for valid input and output", () => {
    const validators = compileOperationValidators(declaration);
    expect(() => assertOperationValue({ title: "Fix redirect" }, validators.input, "input")).not.toThrow();
    expect(() => assertOperationValue({ id: "PEN-184" }, validators.output, "output")).not.toThrow();
    expect(() => assertOperationValue({ title: "" }, validators.input, "input")).toThrow("declared schema");
  });

  it("rejects schemas outside the supported 2020-12 profile", () => {
    expect(() => compileOperationValidators({
      ...declaration,
      input: { type: "string", pattern: "(a+)+$" },
    })).toThrow("not supported");
    expect(() => compileOperationValidators({
      ...declaration,
      input: { type: "not-a-json-schema-type" },
    })).toThrow("invalid JSON Schema");
  });

  it("bounds invocation data before validation", () => {
    const validators = compileOperationValidators(declaration);
    let nested: Record<string, unknown> = { title: "Fix redirect" };
    for (let depth = 0; depth <= APP_OPERATION_VALUE_MAX_DEPTH; depth += 1) nested = { value: nested };
    expect(() => assertOperationValue(nested, validators.input, "input")).toThrow("maximum JSON depth");

    const circular: Record<string, unknown> = { title: "Fix redirect" };
    circular.self = circular;
    expect(() => assertOperationValue(circular, validators.input, "input")).toThrow("circular references");
  });
});
