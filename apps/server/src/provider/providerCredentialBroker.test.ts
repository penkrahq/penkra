import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeProviderCredentialBroker } from "./providerCredentialBroker";

describe("provider credential broker", () => {
  it("disables secret methods when desktop safe storage is unavailable", async () => {
    const broker = makeProviderCredentialBroker({});
    expect(broker.available).toBe(false);
    await expect(Effect.runPromise(broker.store("sentinel"))).rejects.toThrow(
      "unavailable outside Penkra Desktop",
    );
  });
});
