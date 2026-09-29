import { signQaSocketClient } from "@penkra/shared/diagnostics/qaSocketTicket";
import type { QaEvidenceConfig } from "@penkra/shared/diagnostics/qaEvidence";

/** Main computes the complete URL before replying to Electron's synchronous IPC. */
export function desktopQaSocketUrl(input: {
  readonly baseUrl: string;
  readonly config: QaEvidenceConfig;
  readonly clientId: string;
  readonly ticketId: string;
}): string {
  const url = new URL(input.baseUrl);
  url.searchParams.set("qaClientId", input.clientId);
  url.searchParams.set("qaTicketId", input.ticketId);
  url.searchParams.set(
    "qaClientSignature",
    signQaSocketClient(input.config, input.clientId, input.ticketId),
  );
  return url.toString();
}
