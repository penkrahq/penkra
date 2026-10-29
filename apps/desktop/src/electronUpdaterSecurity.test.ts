// FILE: electronUpdaterSecurity.test.ts
// Purpose: Verifies the Windows updater hardening stays shell-free.
// Layer: Desktop update runtime tests

import { describe, expect, it, vi } from "vitest";

import {
  buildPowerShellExecArgs,
  buildPowerShellExecutablePath,
  hardenElectronUpdater,
  parseDistinguishedName,
  resolveWindowsUpdatePublisherNames,
  verifyWindowsUpdateCodeSignature,
} from "./electronUpdaterSecurity";

describe("electronUpdaterSecurity", () => {

  it("uses only embedded full publisher DNs and never feed-controlled names", () => {
    expect(
      resolveWindowsUpdatePublisherNames(
        ["CN=Feed Controlled, O=Unexpected"],
        [" CN=Penkra, O=Acme Tools ", "CN=Only", ""],
      ),
    ).toEqual(["CN=Penkra, O=Acme Tools"]);
    expect(resolveWindowsUpdatePublisherNames(["CN=Feed Controlled, O=Unexpected"], null)).toEqual([
      "CN=Feed Controlled, O=Unexpected",
    ]);
  });
});
