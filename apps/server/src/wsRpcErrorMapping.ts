// FILE: wsRpcErrorMapping.ts
// Purpose: Maps structured server failures to stable client-facing RPC error metadata.
// Layer: Server websocket transport

import { ProviderThreadSwitchCoordinatorError } from "./orchestration/Services/ProviderThreadSwitchCoordinator.ts";
import { ProviderTurnSelectionResolutionError } from "./provider/Services/ProviderTurnSelectionResolver.ts";
import { OrchestrationCommandInvariantError } from "./orchestration/Errors.ts";

export function wsRpcErrorCode(cause: unknown): string | undefined {
  if (cause instanceof OrchestrationCommandInvariantError && cause.code !== undefined) {
    return cause.code;
  }
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
