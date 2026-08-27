import hostPolicy from "./instructions/HOST.md?raw";
import mcpServerInstructions from "./instructions/MCP.md?raw";
import serverManual from "./instructions/SERVER.md?raw";

/**
 * Structured metadata for the host-policy/server-manual pair. The pair is
 * revised as one instruction set even though its two documents travel through
 * different provider channels.
 */
export const PENKRA_INSTRUCTION_SET_VERSION = "2026-08-27";

/** Stable document identities used by delivery tests without freezing prose. */
export const PENKRA_HOST_POLICY_MARKER = "# Penkra";
export const PENKRA_SERVER_MANUAL_MARKER = "# Working with Penkra";
export const PENKRA_MCP_SERVER_INSTRUCTIONS_MARKER = "# Penkra command server";

export function renderPenkraHostPolicy(): string {
  return hostPolicy.trim();
}

export function renderPenkraServerManual(): string {
  return serverManual.trim();
}

export function renderPenkraMcpServerInstructions(): string {
  return mcpServerInstructions.trim();
}

export const PENKRA_HOST_POLICY = renderPenkraHostPolicy();

export interface PenkraHostPolicyDeliveryState {
  hostPolicyDelivered?: boolean;
}

/** Return the private host-context block exactly once for one provider session. */
export function takePenkraHostPolicyForSession(
  state: PenkraHostPolicyDeliveryState,
): string | null {
  if (state.hostPolicyDelivered === true) return null;
  state.hostPolicyDelivered = true;
  return ["<penkra_host_context>", renderPenkraHostPolicy(), "</penkra_host_context>"].join("\n");
}
