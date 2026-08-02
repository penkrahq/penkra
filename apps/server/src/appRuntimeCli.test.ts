import { describe, expect, it } from "vitest";

import { parseOperationInput } from "./appRuntimeCli";

describe("App runtime CLI operation flags", () => {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string" },
      confirm: { type: "boolean" },
      priority: { type: "integer" },
      labels: { type: "array" },
    },
  } as const;

  it("maps schema-declared root command flags to typed App input", () => {
    expect(
      parseOperationInput(schema, undefined, {
        title: "Fix redirect",
        confirm: "true",
        priority: "2",
        labels: '["auth"]',
      }),
    ).toEqual({ title: "Fix redirect", confirm: true, priority: 2, labels: ["auth"] });
  });

  it("rejects unknown, duplicate, and invalid typed flags", () => {
    expect(() => parseOperationInput(schema, undefined, { unknown: "value" })).toThrow(
      "Unknown operation option",
    );
    expect(() => parseOperationInput(schema, '{"title":"one"}', { title: "two" })).toThrow("both");
    expect(() => parseOperationInput(schema, undefined, { confirm: "yes" })).toThrow(
      "true or false",
    );
  });
});
