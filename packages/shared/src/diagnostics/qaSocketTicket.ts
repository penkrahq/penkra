import { createHmac, timingSafeEqual } from "node:crypto";
import type { QaEvidenceConfig } from "./qaEvidence";

const ID = /^[a-f0-9]{32}$/u;
const SIGNATURE = /^[a-f0-9]{64}$/u;

/** Main issues this identity for one trusted shell transport. */
export function signQaSocketClient(config: QaEvidenceConfig, clientId: string): string {
  if (!ID.test(clientId)) throw new TypeError("Invalid QA socket client ID");
  return createHmac("sha256", Buffer.from(config.secret, "hex"))
    .update(`qa-socket:${config.runId}:${clientId}`)
    .digest("hex");
}

export function verifyQaSocketClient(
  config: QaEvidenceConfig,
  clientId: string | null,
  signature: string | null,
): boolean {
  if (!clientId || !signature || !ID.test(clientId) || !SIGNATURE.test(signature)) return false;
  const expected = Buffer.from(signQaSocketClient(config, clientId), "hex");
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
