// Committed composer changes must remain ordered even within one wall-clock millisecond.
export function nextCommittedDraftTimestamp(previous: string | null, requested: string): string {
  if (previous === null || requested > previous) return requested;
  // ISO draft timestamps have millisecond precision; the next representable value is their successor.
  return new Date(Date.parse(previous) + 1).toISOString();
}
