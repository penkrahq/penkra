import { createHash } from "node:crypto";

import { MessageId, ThreadId } from "@penkra/contracts";

export function slugifyAgentTask(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

export function gatewayIsoNow(): string {
  return new Date().toISOString();
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableGatewayDigest(value: unknown, length = 32): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, length);
}

// RFC 9562 UUIDv5 URL namespace; the request identity supplies the UUID name.
const URL_NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
function creationUuid(name: string): string {
  const bytes = createHash("sha1").update(URL_NAMESPACE).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function makeAgentCreationIds(operationId: string) {
  return {
    threadId: ThreadId.make(creationUuid(`${operationId}/thread`)),
    messageId: MessageId.make(creationUuid(`${operationId}/message`)),
  };
}
