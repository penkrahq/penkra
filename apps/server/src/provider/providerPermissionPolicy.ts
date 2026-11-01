import type { RuntimeMode } from "@penkra/contracts";
import { isDeepStrictEqual } from "node:util";

type OpenCodeRule = {
  readonly permission: string;
  readonly pattern: string;
  readonly action: string;
};

/** OpenCode evaluates the last matching rule; a wildcard-led tail overrides earlier rules. */
export function openCodeSessionRulesEnforce(
  sessionRules: readonly OpenCodeRule[] | undefined,
  builtRules: readonly OpenCodeRule[],
): boolean {
  if (builtRules[0]?.permission !== "*" || builtRules[0]?.pattern !== "*") return false;
  if (!sessionRules || sessionRules.length < builtRules.length) return false;
  return isDeepStrictEqual(sessionRules.slice(-builtRules.length), builtRules);
}

export function providerPermissionDecision(runtimeMode: RuntimeMode): "accept" | "decline" {
  return runtimeMode === "full-access" ? "accept" : "decline";
}
