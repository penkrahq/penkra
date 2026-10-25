import { describe, expect, it } from "vitest";
import { encodeNoiseJson } from "./noiseJson";
import { decodePairingResult, encodePairingResult } from "./pairingProtocol";
import { decodeTunnelEnvelope, encodeTunnelEnvelope } from "./tunnelCodec";

describe("encrypted pairing controls", () => {
  it("encodes all four results as exact length-prefixed JSON", () => {
    for (const type of ["paired", "denied", "expired", "failed"] as const) {
      const bytes = Buffer.from(encodePairingResult({ type }));
      expect(bytes.readUInt32BE()).toBe(bytes.length - 4);
      expect(bytes.subarray(4).toString()).toBe(JSON.stringify({ type }));
      expect(decodePairingResult(bytes)).toEqual({ type });
    }
  });
  it("rejects unknown controls and extra data rather than stripping it", () => {
    for (const value of [
      { type: "unknown" },
      { type: "paired", token: "forbidden" },
      { type: "expired", reason: "guessed" },
    ]) {
      expect(() => decodePairingResult(encodeNoiseJson(value))).toThrow(
        "Invalid encrypted pairing result",
      );
    }
  });
  it("cannot confuse a pairing result with an authenticated RPC-session envelope", () => {
    expect(() => decodeTunnelEnvelope(encodePairingResult({ type: "paired" }))).toThrow(
      "invalid-envelope",
    );
    expect(() =>
      decodePairingResult(encodeTunnelEnvelope({ t: "viewing", threadId: null })),
    ).toThrow("Invalid encrypted pairing result");
  });
});
