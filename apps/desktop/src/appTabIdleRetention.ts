import { setTimeout as delay } from "node:timers/promises";
import type { CleanCoreListFolderAppTabsResult } from "@penkra/contracts";

// P23: operator-chosen tab retention and sweep cadence, not failure/retry deadlines.
export const APP_TAB_IDLE_CLOSE_MS = 24 * 60 * 60 * 1000;
export const APP_TAB_IDLE_SWEEP_INITIAL_DELAY_MS = 5 * 60 * 1000;
export const APP_TAB_IDLE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const APP_TAB_IDLE_BATCH_SIZE = 25; // P23: yield after 25 closes.
const APP_TAB_IDLE_BATCH_DELAY_MS = 50; // P23: same 50 ms batch yield as thread retention.

export async function runAppTabIdleSweep(
  now: string,
  input: {
    readPage(afterFolderId?: string): Promise<typeof CleanCoreListFolderAppTabsResult.Type>;
    isVisible(tabId: string): boolean;
    stamp(folderId: string, tabIds: string[], at: string): Promise<void>;
    close(folderId: string, tabId: string, inactiveBefore: string): Promise<boolean>;
    yieldBatch?: () => Promise<void>;
  },
) {
  const cutoff = new Date(Date.parse(now) - APP_TAB_IDLE_CLOSE_MS).toISOString();
  let stamped = 0;
  let closed = 0;
  let afterFolderId: string | undefined;
  do {
    const page = await input.readPage(afterFolderId);
    for (const folder of page.folders) {
      const stamps = folder.tabs.panes
        .filter((pane) => input.isVisible(pane.id) || pane.lastVisibleAt === undefined)
        .map((pane) => pane.id);
      if (stamps.length > 0) {
        await input.stamp(folder.folderId, stamps, now);
        stamped += stamps.length;
      }
      for (const pane of folder.tabs.panes) {
        if (
          stamps.includes(pane.id) ||
          pane.lastVisibleAt === undefined ||
          pane.lastVisibleAt >= cutoff
        )
          continue;
        if (input.isVisible(pane.id)) {
          await input.stamp(folder.folderId, [pane.id], now);
          stamped++;
          continue;
        }
        if (await input.close(folder.folderId, pane.id, cutoff)) {
          closed++;
          if (closed % APP_TAB_IDLE_BATCH_SIZE === 0)
            await (input.yieldBatch?.() ?? delay(APP_TAB_IDLE_BATCH_DELAY_MS));
        }
      }
    }
    afterFolderId = page.nextCursor ?? undefined;
  } while (afterFolderId !== undefined);
  return { stamped, closed, at: now };
}
