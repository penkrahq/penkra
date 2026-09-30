import {
  qaEvidenceConfigFromEnv,
  recordQaAction,
  recordQaActionAsync,
  type QaActionFlow,
  type QaEvidenceConfig,
} from "@penkra/shared/diagnostics/qaEvidence";

declare const __PENKRA_DIAGNOSTICS_QA_PROOF_BUILD__: boolean;

export function serverQaProofConfig(): QaEvidenceConfig | null {
  if (
    typeof __PENKRA_DIAGNOSTICS_QA_PROOF_BUILD__ === "undefined" ||
    !__PENKRA_DIAGNOSTICS_QA_PROOF_BUILD__
  )
    return null;
  return qaEvidenceConfigFromEnv();
}

export function recordServerQaAction(flow: QaActionFlow, traceId: string): void {
  if (serverQaProofConfig()) recordQaAction(flow, traceId);
}

export async function recordServerQaActionAsync(
  flow: QaActionFlow,
  traceId: string,
): Promise<void> {
  if (serverQaProofConfig()) await recordQaActionAsync(flow, traceId);
}
