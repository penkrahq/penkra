import { describe, expect, it } from "vitest";

import { POSSIBLE_MODEL_CATALOG } from "./possibleModels";

describe("POSSIBLE_MODEL_CATALOG", () => {
  it("keeps exact provider/model identities unique and option contracts explicit", () => {
    const identities = POSSIBLE_MODEL_CATALOG.map(
      ({ provider, model }) => `${provider}\u0000${model}`,
    );
    expect(new Set(identities).size).toBe(identities.length);
    expect(POSSIBLE_MODEL_CATALOG).toHaveLength(53);
    expect(POSSIBLE_MODEL_CATALOG).toContainEqual(
      expect.objectContaining({ provider: "opencode", model: "opencode-go/kimi-k3" }),
    );
    for (const model of POSSIBLE_MODEL_CATALOG) {
      for (const option of model.options) {
        expect(option.valueType).toBe("string");
        expect(option.allowsCustomValue || option.allowedValues.length > 0).toBe(true);
      }
    }
  });
});
