// FILE: wsRpcErrorMapping.ts
// Purpose: Maps structured server failures to stable client-facing RPC error metadata.
// Layer: Server websocket transport

import {
  OrchestrationCommandInvariantError,
  findThreadGuardInvariant,
} from "./orchestration/Errors.ts";

export function wsRpcErrorCode(cause: unknown): string | undefined {
  const invariant = findThreadGuardInvariant(cause);
  if (invariant) return invariant.code;
  if (cause instanceof OrchestrationCommandInvariantError && cause.code !== undefined) {
    return cause.code;
  }
  return undefined;
}
