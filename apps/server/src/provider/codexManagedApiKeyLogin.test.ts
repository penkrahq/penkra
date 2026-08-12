import { describe, expect, it } from "vitest";

import { isCodexManagedApiKeyStatus } from "./codexManagedApiKeyLogin";

describe("Codex managed API key status", () => {
  it("accepts current Codex status output from stderr", () => {
    expect(
      isCodexManagedApiKeyStatus("", "Logged in using an API key - sk-proj-***example\n"),
    ).toBe(true);
  });

  it("accepts older Codex status output from stdout", () => {
    expect(isCodexManagedApiKeyStatus("Logged in using an API key\n", "")).toBe(true);
  });

  it("rejects a signed-out profile", () => {
    expect(isCodexManagedApiKeyStatus("Not logged in\n", "")).toBe(false);
  });
});
