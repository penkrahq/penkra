import type { NativeApi, ThreadId } from "@penkra/contracts";

type ThreadUpdater = Pick<NativeApi["cleanCore"], "updateThread">;

export async function archiveThreadFromClient(
  api: ThreadUpdater,
  threadId: ThreadId,
): Promise<void> {
  const updatedAt = new Date().toISOString();
  await api.updateThread({
    update: { action: "archive", threadId, archivedAt: updatedAt, updatedAt },
  });
}

export async function unarchiveThreadFromClient(
  api: ThreadUpdater,
  threadId: ThreadId,
): Promise<void> {
  await api.updateThread({
    update: { action: "archive", threadId, archivedAt: null, updatedAt: new Date().toISOString() },
  });
}
