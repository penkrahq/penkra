import { useState } from "react";

import { ButtonBack } from "~/components/foundations/button-back/ButtonBack";
import { ButtonPrimary } from "~/components/foundations/button-primary/ButtonPrimary";

import { AgentCardVerticalShared } from "../agent-card-vertical-shared/AgentCardVerticalShared";
import { OnboardingLayout } from "../shared/OnboardingLayout";

export interface OnboardingConnectAgentProps {
  onBack?: () => void;
  onContinue?: (agents: readonly string[]) => void;
}

export function OnboardingConnectAgent({
  onBack,
  onContinue,
}: OnboardingConnectAgentProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const agents = [
    { description: "Anthropic", id: "claude", label: "Claude", provider: "claudeAgent" as const },
    { description: "OpenAI", id: "codex", label: "Codex", provider: "codex" as const },
    { description: "Cursor", id: "cursor", label: "Cursor", provider: "cursor" as const },
  ];

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <OnboardingLayout>
      <ButtonBack className="absolute top-7 left-7" onClick={onBack} />
      <div className="w-[488px] font-sans" data-pencil-component="X4Yqda">
        <h1 className="text-2xl font-semibold">Connect an agent to get started</h1>
        <p className="mt-2 text-sm text-[var(--color-text-foreground-secondary)]">
          Pick at least one — you can add more anytime.
        </p>
        <div className="mt-6 flex gap-3">
          {agents.map((agent) => (
            <AgentCardVerticalShared
              description={agent.description}
              key={agent.id}
              onClick={() => toggle(agent.id)}
              provider={agent.provider}
              selected={selected.has(agent.id)}
            >
              {agent.label}
            </AgentCardVerticalShared>
          ))}
        </div>
        <ButtonPrimary
          className="mt-6"
          disabled={selected.size === 0}
          onClick={() => onContinue?.([...selected])}
        >
          Continue
        </ButtonPrimary>
      </div>
    </OnboardingLayout>
  );
}
