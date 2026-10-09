// FILE: threadItemData.ts
// Purpose: The single source of truth for `thread_items.data`. Tool/notice items
// carry one bounded copy of the canonical thread activity record, so the web can
// feed the existing TimelineWorkEntryRow through deriveWorkLogEntries (TODO.md
// 2.1). The 64 KB cap is applied by capThreadItemData.
// Layer: Server clean core
// Exports: THREAD_ITEM_DATA_LIMIT_BYTES, capThreadItemData, ThreadItemActivityData,
//   threadItemActivityData

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

/**
 * The one canonical tool/notice payload shape stored on a `thread_items` row.
 * `tone`, `kind`, `summary` and `payload` mirror an `OrchestrationThreadActivity`
 * minus the fields the item row already owns (id = sourceId, turnId, sequence,
 * createdAt). providerEventBridge.threadItemActivityData serializes this shape
 * and migration 176's SQL builds the identical JSON keys, so the live bridge and
 * the Production backfill cannot drift.
 */
export interface ThreadItemActivityData {
  readonly tone: string;
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
}

export function threadItemActivityData(activity: {
  readonly tone: string;
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
}): string {
  return JSON.stringify({
    tone: activity.tone,
    kind: activity.kind,
    summary: activity.summary,
    payload: activity.payload,
  } satisfies ThreadItemActivityData);
}
