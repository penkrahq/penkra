// Provider quota updates are per bucket, not replacements of the entire account.
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;

export interface CodexQuotaObservation {
  bucket: RecordValue;
  observedAt: string;
}

export function codexQuotaObservations(
  payload: unknown,
  observedAt: string,
): Map<string, CodexQuotaObservation> {
  const result = new Map<string, CodexQuotaObservation>();
  const visit = (value: unknown): void => {
    const root = record(value);
    if (!root) return;
    const stored = record(root.quotaBuckets);
    if (stored) {
      for (const [id, value] of Object.entries(stored)) {
        const entry = record(value);
        const bucket = record(entry?.bucket);
        if (bucket && typeof entry?.observedAt === "string") {
          result.set(id, { bucket, observedAt: entry.observedAt });
        }
      }
      return;
    }
    visit(root.rateLimits);
    const byId = record(root.rateLimitsByLimitId);
    if (byId) {
      for (const [id, value] of Object.entries(byId)) {
        const bucket = record(value);
        if (bucket) result.set(id, { bucket: { ...bucket, limitId: id }, observedAt });
      }
    }
    if (typeof root.limitId === "string" && root.limitId.length > 0) {
      result.set(root.limitId, { bucket: root, observedAt });
    }
  };
  visit(payload);
  return result;
}

export function mergeCodexQuotaFacts(
  previousJson: string | undefined,
  previousAt: string | undefined,
  incomingJson: string,
  incomingAt: string,
): string {
  const incoming = codexQuotaObservations(JSON.parse(incomingJson), incomingAt);
  // Unidentified legacy data cannot safely be assigned to a named quota.
  if (incoming.size === 0) return incomingJson;
  const buckets = previousJson
    ? codexQuotaObservations(JSON.parse(previousJson), previousAt ?? incomingAt)
    : new Map<string, CodexQuotaObservation>();
  for (const [id, next] of incoming) {
    const previous = buckets.get(id);
    if (!previous || Date.parse(next.observedAt) >= Date.parse(previous.observedAt)) {
      buckets.set(id, next);
    }
  }
  return JSON.stringify({ quotaBuckets: Object.fromEntries(buckets) });
}
