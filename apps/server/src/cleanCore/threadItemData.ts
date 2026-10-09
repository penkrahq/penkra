// FILE: threadItemData.ts
// Purpose: The single source of truth for the thread_items.data cap
// (TODO.md 2.1: one bounded copy, 64 KB per item, truncated with
// "truncated": true and the original byte length recorded).
// Layer: Server clean core
// Exports: THREAD_ITEM_DATA_LIMIT_BYTES, capThreadItemData

export const THREAD_ITEM_DATA_LIMIT_BYTES = 64 * 1024;

/**
 * Caps one item's `data` copy. Under the limit it is returned unchanged;
 * over it, a JSON object records the original byte length and a prefix
 * preview. The migration's SQL builds the identical shape (key order
 * truncated, originalBytes, preview), so the two cannot drift.
 */
export function capThreadItemData(data: string | null): string | null {
  if (data === null) return null;
  if (data.length <= THREAD_ITEM_DATA_LIMIT_BYTES) return data;
  return JSON.stringify({
    truncated: true,
    originalBytes: data.length,
    preview: data.slice(0, THREAD_ITEM_DATA_LIMIT_BYTES),
  });
}
