import { assert, describe, it } from "@effect/vitest";

import {
  providerConnectionProfileRoot,
  providerCredentialProfileIdentity,
  providerCredentialProfileRoot,
} from "./providerNativeStatePaths.ts";

describe("provider credential profile paths", () => {
  it("preserves every released Connection-backed profile path exactly", () => {
    const stateDir = "/penkra-state";
    assert.strictEqual(
      providerCredentialProfileRoot(stateDir, "provider-profile:released-connection"),
      providerConnectionProfileRoot(stateDir, "released-connection"),
    );
  });

  it("gives each immutable credential generation a distinct address", () => {
    const stateDir = "/penkra-state";
    assert.notStrictEqual(
      providerCredentialProfileRoot(stateDir, "provider-profile:generation-one"),
      providerCredentialProfileRoot(stateDir, "provider-profile:generation-two"),
    );
  });

  it("rejects malformed profile references instead of guessing an address", () => {
    assert.strictEqual(providerCredentialProfileIdentity("connection-id"), null);
    assert.strictEqual(providerCredentialProfileIdentity("provider-profile:   "), null);
    assert.strictEqual(providerCredentialProfileRoot("/penkra-state", "connection-id"), null);
  });
});
