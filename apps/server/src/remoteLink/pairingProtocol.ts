import { Schema } from "effect";
import { decodeNoiseJson, encodeNoiseJson } from "./noiseJson";

const Result = Schema.Struct({ type: Schema.Literals(["paired", "denied", "expired", "failed"]) });
export type PairingResult = typeof Result.Type;
const validate = Schema.decodeUnknownSync(Result, { onExcessProperty: "error" });
export function encodePairingResult(result: PairingResult): Uint8Array {
  return encodeNoiseJson(validate(result));
}
export function decodePairingResult(bytes: Uint8Array): PairingResult {
  try {
    return validate(decodeNoiseJson(bytes));
  } catch {
    throw new Error("Invalid encrypted pairing result.");
  }
}
