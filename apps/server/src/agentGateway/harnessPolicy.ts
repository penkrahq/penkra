import type { ProviderKind } from "@penkra/contracts";

/** Canonical, versioned host policy delivered to every supported provider. */
export const PENKRA_HARNESS_POLICY_VERSION = "2026-07-23.7";
export const PENKRA_HARNESS_POLICY_MARKER = `[Penkra harness policy ${PENKRA_HARNESS_POLICY_VERSION}]`;

export interface PenkraHarnessCapabilities {
  readonly gatewayControlAvailable: boolean;
}

/**
 * Render one truthful policy. Providers without a safely thread-scoped MCP
 * connection still receive host identity, but are never told they can mutate
 * Penkra resources.
 */
export function renderPenkraHarnessPolicy(capabilities: PenkraHarnessCapabilities): string {
  const controlPolicy = capabilities.gatewayControlAvailable
    ? [
        "Use the penkra_* tools for Penkra threads, projects, and coordination.",
        "For thread discovery and diagnosis, use penkra_list_threads, penkra_read_thread, penkra_read_thread_activity, penkra_read_thread_events, penkra_read_thread_runtime_events, and penkra_diagnose_thread before inspecting Penkra's SQLite files or process logs. Fall back to host storage only when a tool's coverage metadata says the required evidence is unavailable.",
        "Provider-native subagent or Task tools are implementation details: they do not create Penkra threads and must not substitute for an explicit request to create Penkra threads.",
        "For a plural thread request, submit one exact penkra_create_threads plan. The array length is the exact requested count.",
        "Give every planned thread a 3–8 word outcome-oriented task label and self-contained instructions with no assumed chat context.",
        "If penkra_create_threads rejects the plan during validation or preflight before returning an operationId, correct that same plan and retry it with the same requestId. This is safe because no durable operation, thread, or worktree was created.",
        "Use penkra_capabilities to select canonical provider, model, and option values. Never guess a model slug or silently substitute a provider or model.",
        "Provider option keys are not interchangeable: Codex uses options.reasoningEffort and Claude Agent uses options.effort. Follow penkra_capabilities.targetConstruction for every provider instead of inspecting Penkra source code.",
        "When results are requested, call penkra_wait_for_threads for the created thread ids, wait for every requested result, then synthesize all outcomes.",
        'Use penkra_send_message for a later manual follow-up such as "continue" on an existing thread. Never call this tool for a manual follow-up turn that belongs in the current conversation.',
        "When coordinating background work, make a deliberate choice between notifying the user versus staying silent until a meaningful result is ready.",
        "After penkra_create_threads returns an operationId, retries must keep the same requestId and exact plan. Report terminal operation failures as outcomes; do not create replacement threads unless the user gives a new instruction.",
      ]
    : [
        "Penkra MCP control is unavailable in this provider session. Do not claim that Penkra threads or projects were created or changed.",
        "Provider-native subagent or Task tools do not create Penkra threads. If the user explicitly requests Penkra resource management, explain that this session cannot perform it.",
      ];

  return [
    PENKRA_HARNESS_POLICY_MARKER,
    "You are running inside Penkra. Penkra is the host and harness for this session.",
    ...controlPolicy,
  ].join("\n");
}

export const PENKRA_GATEWAY_HARNESS_POLICY = renderPenkraHarnessPolicy({
  gatewayControlAvailable: true,
});

export const PENKRA_IDENTITY_ONLY_HARNESS_POLICY = renderPenkraHarnessPolicy({
  gatewayControlAvailable: false,
});

export interface PenkraHarnessPolicyDeliveryState {
  harnessPolicyDelivered?: boolean;
}

const PROVIDERS_WITH_THREAD_SCOPED_PENKRA_MCP = new Set<ProviderKind>([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "droid",
  "opencode",
  "kilo",
  "pi",
]);

export function providerHasPenkraGatewayControl(input: {
  readonly provider: ProviderKind;
  readonly scopedGatewayConnectionAvailable: boolean;
}): boolean {
  return (
    input.scopedGatewayConnectionAvailable &&
    PROVIDERS_WITH_THREAD_SCOPED_PENKRA_MCP.has(input.provider)
  );
}

/** Return the private host-context block exactly once for one provider session. */
export function takePenkraHarnessPolicyForSession(
  state: PenkraHarnessPolicyDeliveryState,
  capabilities: PenkraHarnessCapabilities,
): string | null {
  if (state.harnessPolicyDelivered === true) return null;
  state.harnessPolicyDelivered = true;
  return [
    "<penkra_host_context>",
    renderPenkraHarnessPolicy(capabilities),
    "</penkra_host_context>",
  ].join("\n");
}

/**
 * Provider-aware delivery guard. The transport flag must only become true
 * after a provider has installed thread-scoped gateway tools successfully.
 */
export function takePenkraHarnessPolicyForProviderSession(
  state: PenkraHarnessPolicyDeliveryState,
  input: {
    readonly provider: ProviderKind;
    readonly scopedGatewayConnectionAvailable: boolean;
  },
): string | null {
  return takePenkraHarnessPolicyForSession(state, {
    gatewayControlAvailable: providerHasPenkraGatewayControl(input),
  });
}

export function takePenkraHarnessPolicyTextPartForProviderSession(
  state: PenkraHarnessPolicyDeliveryState,
  input: {
    readonly provider: ProviderKind;
    readonly scopedGatewayConnectionAvailable: boolean;
  },
): { readonly type: "text"; readonly text: string } | null {
  const text = takePenkraHarnessPolicyForProviderSession(state, input);
  return text === null ? null : { type: "text", text };
}
