// FILE: threadCreatePromotion.ts
// Purpose: Makes draft-to-server thread promotion idempotent across racing UI callers.
// Layer: Web orchestration helper
// Exports: promoteThreadCreate, isDuplicateThreadCreateError

import type { ClientOrchestrationCommand, NativeApi, ThreadId } from "@penkra/contracts";
import { markPromotedDraftThreads } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { getThreadFromState } from "../threadDerivation";

type ThreadCreateCommand = Extract<ClientOrchestrationCommand, { type: "thread.create" }>;

type PromoteThreadCreateResult = "created" | "exists" | "unavailable";
interface PromoteThreadCreateOptions {
  // Draft-aware callers use this when React knows the route is still local.
  readonly force?: boolean;
}

const inFlightThreadCreateById = new Map<ThreadId, Promise<PromoteThreadCreateResult>>();

export function isDuplicateThreadCreateError(error: unknown, threadId: ThreadId): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" && error !== null && "message" in error
          ? String((error as { message?: unknown }).message ?? "")
          : "";
  return (
    message.includes("Orchestration command invariant failed (thread.create)") &&
    message.includes(`Thread '${threadId}' already exists and cannot be created twice.`)
  );
}

async function recoverPromotedThreadFromShellSnapshot(
  api: NativeApi,
  threadId: ThreadId,
  minimumSnapshotSequence?: number,
): Promise<boolean> {
  const snapshot = await api.orchestration.getShellSnapshot();
  if (
    minimumSnapshotSequence !== undefined &&
    snapshot.snapshotSequence < minimumSnapshotSequence
  ) {
    return false;
  }
  useStore.getState().syncServerShellSnapshot(snapshot);
  const recovered = getThreadFromState(useStore.getState(), threadId) !== null;
  if (recovered) {
    markPromotedDraftThreads(new Set([threadId]));
  }
  return recovered;
}

async function dispatchPromoteThreadCreate(
  api: NativeApi,
  command: ThreadCreateCommand,
  options: PromoteThreadCreateOptions = {},
): Promise<PromoteThreadCreateResult> {
  if (!options.force && getThreadFromState(useStore.getState(), command.threadId)) {
    markPromotedDraftThreads(new Set([command.threadId]));
    return "exists";
  }

  let receipt: Awaited<ReturnType<NativeApi["orchestration"]["dispatchCommand"]>>;
  try {
    receipt = await api.orchestration.dispatchCommand(command);
  } catch (error) {
    // A transport failure can arrive after the server committed thread.create.
    // Confirm authoritative state before deciding the create failed or retrying it.
    try {
      if (await recoverPromotedThreadFromShellSnapshot(api, command.threadId)) {
        return "exists";
      }
    } catch {
      // Preserve the original failure if authoritative recovery is unavailable.
    }
    throw error;
  }

  const installed = await recoverPromotedThreadFromShellSnapshot(
    api,
    command.threadId,
    receipt.sequence,
  );
  if (!installed) {
    throw new Error(
      `Accepted thread.create for '${command.threadId}' was not present in the authoritative shell snapshot.`,
    );
  }
  return "created";
}

export async function promoteThreadCreate(
  command: ThreadCreateCommand,
  api: NativeApi | undefined = readNativeApi(),
  options: PromoteThreadCreateOptions = {},
): Promise<PromoteThreadCreateResult> {
  if (!api) {
    return "unavailable";
  }
  const existing = inFlightThreadCreateById.get(command.threadId);
  if (existing) {
    await existing;
    return "exists";
  }

  const promise = dispatchPromoteThreadCreate(api, command, options).finally(() => {
    inFlightThreadCreateById.delete(command.threadId);
  });
  inFlightThreadCreateById.set(command.threadId, promise);
  return promise;
}
