// FILE: providerMetadata.ts
// Purpose: Exhaustive non-secret provider identity and presentation metadata.

import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@penkra/contracts";

export interface ProviderDescriptor {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly adapterImplemented: boolean;
  readonly supportsNativeTurnSteering: boolean;
  readonly usage: {
    readonly signInCommand: string;
    readonly learnMoreHref: string;
  } | null;
}

export const PROVIDER_DESCRIPTORS = [
  {
    kind: "codex",
    displayName: PROVIDER_DISPLAY_NAMES.codex,
    adapterImplemented: true,
    supportsNativeTurnSteering: true,
    usage: {
      signInCommand: "codex login",
      learnMoreHref: "https://platform.openai.com/usage",
    },
  },
  {
    kind: "claudeAgent",
    displayName: PROVIDER_DISPLAY_NAMES.claudeAgent,
    adapterImplemented: true,
    supportsNativeTurnSteering: true,
    usage: {
      signInCommand: "claude",
      learnMoreHref: "https://docs.anthropic.com/en/docs/about-claude/models#rate-limits",
    },
  },
  {
    kind: "opencode",
    displayName: PROVIDER_DISPLAY_NAMES.opencode,
    adapterImplemented: true,
    supportsNativeTurnSteering: false,
    usage: null,
  },
] as const satisfies readonly ProviderDescriptor[];

export const PROVIDER_DESCRIPTOR_BY_KIND = Object.fromEntries(
  PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.kind, descriptor]),
) as Record<ProviderKind, (typeof PROVIDER_DESCRIPTORS)[number]>;

export const providerSupportsNativeTurnSteering = (kind: string): boolean =>
  PROVIDER_DESCRIPTORS.some(
    (descriptor) => descriptor.kind === kind && descriptor.supportsNativeTurnSteering,
  );
