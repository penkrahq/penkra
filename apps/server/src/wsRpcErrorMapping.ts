// FILE: wsRpcErrorMapping.ts
// Purpose: Maps structured server failures to stable client-facing RPC error metadata.
// Layer: Server websocket transport

import { ProviderThreadSwitchCoordinatorError } from "./orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ProviderTurnSelectionResolutionError } from "./provider/Services/ProviderTurnSelectionResolver.ts";

export function bindingRevisionErrorCode(cause: unknown): string | undefined {
  const selectionCause =
    cause instanceof ProviderThreadSwitchCoordinatorError &&
    cause.cause instanceof ProviderTurnSelectionResolutionError
      ? cause.cause
      : cause instanceof ProviderTurnSelectionResolutionError
        ? cause
        : null;
  if (selectionCause?.reason === "binding-revision-required") {
    return "THREAD_BINDING_REVISION_REQUIRED";
  }
  if (selectionCause?.reason === "binding-revision-stale") {
    return "THREAD_BINDING_REVISION_STALE";
  }
  return undefined;
}
