// Purpose: Promote a composer draft through the idempotent clean-core creator.
import type {
  CleanCoreCreateThreadInput,
  CleanCoreCreateThreadResponse,
  NativeApi,
} from "@penkra/contracts";
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
  applyThreadCreationResponse(result);
  return result.created ? "created" : "exists";
}

export function applyThreadCreationResponse(result: CleanCoreCreateThreadResponse): void {
  applyThreadRow(result.thread);
  useStore.getState().syncServerThreadShell(result.thread.id, result.shell);
  markPromotedDraftThreads(new Set([result.thread.id]));
}
