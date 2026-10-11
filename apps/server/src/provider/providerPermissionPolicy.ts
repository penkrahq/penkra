import type { RuntimeMode } from "@penkra/contracts";

export function providerPermissionDecision(runtimeMode: RuntimeMode): "accept" | "decline" {
  return runtimeMode === "full-access" ? "accept" : "decline";
}
