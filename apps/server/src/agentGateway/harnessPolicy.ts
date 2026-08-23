import document from "./instructions/INSTRUCTIONS.md?raw";

/**
 * Structured metadata only. The version identifies the host contract in diagnostic payloads
 * (see `threadReadTools.ts`) and is deliberately never rendered into instruction text: a
 * version string spends context on something no agent can act on.
 */
export const PENKRA_HARNESS_POLICY_VERSION = "2026-08-23";

/**
 * The document's title line, and the stable string that identifies a delivered host document.
 * Delivery tests assert on this rather than on prose, so the document can be rewritten freely.
 */
export const PENKRA_HARNESS_POLICY_MARKER = "# Penkra";

/**
 * The canonical host document delivered to every supported provider.
 *
 * There is exactly one source of host instruction prose: `instructions/INSTRUCTIONS.md`.
 * Session injection renders it as-is; `penkra --help` renders the same document with the
 * live App catalog and operation list appended (see `instructions/assemble.ts`). Adapters
 * choose a delivery mechanism and never author or paraphrase instruction text.
 */
export function renderPenkraHarnessPolicy(): string {
  return document.trim();
}

export const PENKRA_GATEWAY_HARNESS_POLICY = renderPenkraHarnessPolicy();

export interface PenkraHarnessPolicyDeliveryState {
  harnessPolicyDelivered?: boolean;
}

/** Return the host document exactly once for one provider session. */
export function takePenkraHarnessPolicyForSession(
  state: PenkraHarnessPolicyDeliveryState,
): string | null {
  if (state.harnessPolicyDelivered === true) return null;
  state.harnessPolicyDelivered = true;
  return ["<penkra_host_context>", renderPenkraHarnessPolicy(), "</penkra_host_context>"].join(
    "\n",
  );
}

/**
 * Delivery for providers that inject the document as a session text part.
 *
 * Identical to `takePenkraHarnessPolicyForSession`; kept as a named entry point so adapter
 * call sites read as a deliberate delivery choice rather than an incidental import.
 */
export function takePenkraHarnessPolicyForProviderSession(
  state: PenkraHarnessPolicyDeliveryState,
): string | null {
  return takePenkraHarnessPolicyForSession(state);
}

export function takePenkraHarnessPolicyTextPartForProviderSession(
  state: PenkraHarnessPolicyDeliveryState,
): { readonly type: "text"; readonly text: string } | null {
  const text = takePenkraHarnessPolicyForProviderSession(state);
  return text === null ? null : { type: "text", text };
}
