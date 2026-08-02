// FILE: appRegistryIpc.ts
// Purpose: Validates the Apps-only registry IPC messages before trusted network access.
// Layer: Desktop IPC contract

const APP_SLUG = /^[a-z][a-z0-9-]{1,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseRegistryListRequest(value: unknown): {
  query?: string;
  cursor?: string;
  limit?: number;
} {
  if (value === undefined || value === null) return {};
  const input = record(value);
  const allowed = new Set(["query", "cursor", "limit"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw invalidRequest();
  const result: { query?: string; cursor?: string; limit?: number } = {};
  if (input.query !== undefined) {
    if (typeof input.query !== "string" || input.query.trim().length > 200) throw invalidRequest();
    result.query = input.query.trim();
  }
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || !UUID.test(input.cursor)) throw invalidRequest();
    result.cursor = input.cursor;
  }
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100) {
      throw invalidRequest();
    }
    result.limit = input.limit as number;
  }
  return result;
}

export function parseRegistryGetRequest(value: unknown): { slug: string } {
  const input = record(value);
  if (Object.keys(input).length !== 1 || typeof input.slug !== "string" || !APP_SLUG.test(input.slug)) {
    throw invalidRequest();
  }
  return { slug: input.slug };
}

export function parseRegistryArtifactRequest(value: unknown): {
  id: string;
  source: "artifact" | "asset";
} {
  const input = record(value);
  if (
    Object.keys(input).length !== 2 ||
    typeof input.id !== "string" ||
    !UUID.test(input.id) ||
    (input.source !== "artifact" && input.source !== "asset")
  ) {
    throw invalidRequest();
  }
  return { id: input.id, source: input.source };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRequest();
  return value as Record<string, unknown>;
}

function invalidRequest(): Error {
  return new Error("Invalid App registry request.");
}
