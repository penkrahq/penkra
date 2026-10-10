// Purpose: Promote a composer draft through the idempotent clean-core creator.
import type { CleanCoreCreateThreadInput, NativeApi } from "@penkra/contracts";
import { markPromotedDraftThreads } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { applyThreadRow } from "../threadListStore";
import { useStore } from "../store";

export async function promoteThreadCreate(
  input: CleanCoreCreateThreadInput,
  api: NativeApi | undefined = readNativeApi(),
): Promise<"created" | "exists" | "unavailable"> {
  if (!api) return "unavailable";
  const result = await api.cleanCore.createThread(input);
  applyThreadRow(result.thread);
  useStore.getState().syncServerThreadShell(result.thread.id, result.shell);
  markPromotedDraftThreads(new Set([result.thread.id]));
  if (result.created) useStore.getState().markThreadDetailKnownEmpty(result.thread.id);
  return result.created ? "created" : "exists";
}
