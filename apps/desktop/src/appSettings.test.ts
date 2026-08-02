import { describe, expect, it } from "vitest";

import { appSettingSecretName, validateAppSettingValue } from "./appSettings";

describe("App Settings declarations", () => {
  it("validates typed values and bounds", () => {
    expect(() =>
      validateAppSettingValue(
        {
          key: "font-size",
          label: "Font size",
          type: "number",
          default: 14,
          validation: { minimum: 10, maximum: 24, step: 2 },
        },
        16,
      ),
    ).not.toThrow();
    expect(() =>
      validateAppSettingValue(
        {
          key: "font-size",
          label: "Font size",
          type: "number",
          default: 14,
          validation: { minimum: 10, maximum: 24, step: 2 },
        },
        15,
      ),
    ).toThrow("step of 2");
    expect(() =>
      validateAppSettingValue(
        {
          key: "density",
          label: "Density",
          type: "select",
          default: "comfortable",
          options: [{ value: "comfortable", label: "Comfortable" }],
        },
        "compact",
      ),
    ).toThrow("declared option");
  });

  it("maps sensitive keys to stable bounded opaque vault names", () => {
    expect(appSettingSecretName("api-token")).toMatch(/^setting-[a-f0-9]{32}$/);
    expect(appSettingSecretName("api-token")).toBe(appSettingSecretName("api-token"));
    expect(appSettingSecretName("other-token")).not.toBe(appSettingSecretName("api-token"));
  });
});
