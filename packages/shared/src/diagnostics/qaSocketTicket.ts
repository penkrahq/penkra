import { createHmac, timingSafeEqual } from "node:crypto";
import type { QaEvidenceConfig } from "./qaEvidence";

const ID = /^[a-f0-9]{32}$/u;
const SIGNATURE = /^[a-f0-9]{64}$/u;

/** Main issues this identity for one trusted shell transport. */
export function signQaSocketClient(
  config: QaEvidenceConfig,
  clientId: string,
  ticketId: string,
): string {
  if (!ID.test(clientId) || !ID.test(ticketId)) throw new TypeError("Invalid QA socket ticket");
  return createHmac("sha256", Buffer.from(config.secret, "hex"))
    .update(`qa-socket:${config.runId}:${clientId}:${ticketId}`)
    .digest("hex");
}

export function verifyQaSocketClient(
  config: QaEvidenceConfig,
  clientId: string | null,
  ticketId: string | null,
  signature: string | null,
): boolean {
  if (
    !clientId ||
    !ticketId ||
    !signature ||
    !ID.test(clientId) ||
    !ID.test(ticketId) ||
    !SIGNATURE.test(signature)
  )
    return false;
  const expected = Buffer.from(signQaSocketClient(config, clientId, ticketId), "hex");
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
