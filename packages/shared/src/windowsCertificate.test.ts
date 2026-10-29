// FILE: windowsCertificate.test.ts
// Purpose: Keeps Windows signer identity matching consistent across desktop and release checks.
// Layer: Shared utility tests

import { describe, expect, it } from "vitest";

import { matchesDistinguishedName, parseDistinguishedName } from "./windowsCertificate";

describe("windowsCertificate", () => {

  it("rejects incomplete pins and mismatched signer fields", () => {
    expect(matchesDistinguishedName("CN=Penkra", "CN=Penkra, O=Acme Tools")).toBe(false);
    expect(matchesDistinguishedName("CN=Penkra, O=Acme Tools", "CN=Penkra, O=Other Tools")).toBe(
      false,
    );
  });
});
