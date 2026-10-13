// FILE: wsRpcErrorMapping.ts
// Purpose: Maps structured server failures to stable client-facing RPC error metadata.
// Layer: Server websocket transport

import { ThreadPolicyError, findThreadPolicyError } from "./cleanCore/threadErrors.ts";

export function wsRpcErrorCode(cause: unknown): string | undefined {
  const invariant = findThreadPolicyError(cause);
  if (invariant) return invariant.code;
  if (cause instanceof ThreadPolicyError && cause.code !== undefined) {
    return cause.code;
  }
  return undefined;
}
