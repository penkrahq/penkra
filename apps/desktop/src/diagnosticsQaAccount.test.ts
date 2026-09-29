import { describe, expect, it } from "vitest";
import { diagnosticsQaAccountEnabled } from "./diagnosticsQaAccount";

const allowed = {
  isPackaged: false,
  isDevelopment: true,
  root: "/tmp/penkra-diagnostics-qa-0143.Abc123/root",
  smokeProfile: "/tmp/penkra-diagnostics-qa-0143.Abc123/electron-profile",
  proofDir: "/tmp/penkra-diagnostics-qa-0143.Abc123/proofs",
  runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  secret: "ab".repeat(32),
};

describe("diagnosticsQaAccountEnabled", () => {
  it("allows an unpackaged isolated smoke run", () => {
    expect(diagnosticsQaAccountEnabled(allowed)).toBe(true);
  });

  it("rejects packaged and ordinary Dev launches", () => {
    expect(diagnosticsQaAccountEnabled({ ...allowed, isPackaged: true })).toBe(false);
    expect(diagnosticsQaAccountEnabled({ ...allowed, smokeProfile: undefined })).toBe(false);
    expect(diagnosticsQaAccountEnabled({ ...allowed, root: "/Applications/Penkra.app" })).toBe(
      false,
    );
    expect(diagnosticsQaAccountEnabled({ ...allowed, secret: undefined })).toBe(false);
  });
});
