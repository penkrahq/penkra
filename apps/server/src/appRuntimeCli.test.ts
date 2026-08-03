import { describe, expect, it } from "vitest";

import { parseOperationInput, tokenizeRegisteredCommand } from "./appRuntimeCli";

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

describe("penkra_exec command tokenization", () => {
  it("preserves quoted structured input without invoking a shell", () => {
    expect(
      tokenizeRegisteredCommand(
        `linear issues create --title "Fix redirect" --input '{"priority":2}'`,
      ),
    ).toEqual([
      "linear",
      "issues",
      "create",
      "--title",
      "Fix redirect",
      "--input",
      '{"priority":2}',
    ]);
  });

  it("rejects shell syntax and expansion", () => {
    for (const command of [
      "ffmpeg encode | cat",
      "linear issues list > out",
      "echo $HOME",
      "x $(y)",
    ]) {
      expect(() => tokenizeRegisteredCommand(command)).toThrow();
    }
  });

  it("does not confuse a native executable name with an App root", () => {
    expect(tokenizeRegisteredCommand("ffmpeg media encode --input '{}'")[0]).toBe("ffmpeg");
    expect(tokenizeRegisteredCommand("penkra tabs current")[0]).toBe("penkra");
  });
});
