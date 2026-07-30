import { IconBrandGithub } from "@tabler/icons-react";
import { useState } from "react";

import { ButtonBack } from "~/components/foundations/button-back/ButtonBack";
import { ScrollArea } from "~/components/ui/scroll-area";

import { AgentCardClaude } from "../agent-card-claude/AgentCardClaude";
import { AgentCardCodex } from "../agent-card-codex/AgentCardCodex";
import { AgentCardCursor } from "../agent-card-cursor/AgentCardCursor";
import { AgentCardVerticalShared } from "../agent-card-vertical-shared/AgentCardVerticalShared";
import { AgentGridRow } from "../agent-grid-row/AgentGridRow";
import { OnboardingActionsAgents } from "../onboarding-actions-agents/OnboardingActionsAgents";
import {
  onboardingIllustrations,
  OnboardingLayout,
} from "../shared/OnboardingLayout";

export interface OnboardingConnectAgentProps {
  onBack?: () => void;
  onContinue?: (agents: readonly string[]) => void;
}

export function OnboardingConnectAgent({
  onBack,
  onContinue,
}: OnboardingConnectAgentProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(["claude"]),
  );
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <OnboardingLayout brandImage={onboardingIllustrations.connectAgent}>
      <ButtonBack className="absolute top-7 left-7" onClick={onBack} />
      <div className="w-[488px] font-sans" data-pencil-component="X4Yqda">
        <h1 className="text-2xl font-semibold">Connect an agent to get started</h1>
        <p className="mt-2 text-sm text-[var(--color-text-foreground-secondary)]">
          Pick at least one — you can add more anytime.
        </p>
        <ScrollArea
          aria-label="Available agents"
          className="mt-6 h-[340px]"
          hideScrollbars
          scrollFade
        >
          <div className="flex flex-col gap-3 pb-1">
            <AgentGridRow>
              <AgentCardClaude
                onClick={() => toggle("claude")}
                selected={selected.has("claude")}
              />
              <AgentCardCodex
                onClick={() => toggle("codex")}
                selected={selected.has("codex")}
              />
              <AgentCardCursor
                onClick={() => toggle("cursor")}
                selected={selected.has("cursor")}
              />
            </AgentGridRow>
            <AgentGridRow>
              <AgentCardVerticalShared
                description="Not connected"
                onClick={() => toggle("grok")}
                provider="grok"
                selected={selected.has("grok")}
              >
                Grok
              </AgentCardVerticalShared>
              <AgentCardVerticalShared
                description="Not connected"
                onClick={() => toggle("droid")}
                provider="droid"
                selected={selected.has("droid")}
              >
                Droid
              </AgentCardVerticalShared>
              <AgentCardVerticalShared
                description="Not connected"
                onClick={() => toggle("kilo")}
                provider="kilo"
                selected={selected.has("kilo")}
              >
                Kilo
              </AgentCardVerticalShared>
            </AgentGridRow>
            <AgentGridRow>
              <AgentCardVerticalShared
                description="Not connected"
                onClick={() => toggle("pi")}
                provider="pi"
                selected={selected.has("pi")}
              >
                Pi
              </AgentCardVerticalShared>
              <AgentCardVerticalShared
                description="Not connected"
                icon={<IconBrandGithub className="size-10" />}
                onClick={() => toggle("github")}
                selected={selected.has("github")}
              >
                GitHub
              </AgentCardVerticalShared>
              <AgentCardVerticalShared
                description="Not connected"
                onClick={() => toggle("opencode")}
                provider="opencode"
                selected={selected.has("opencode")}
              >
                OpenCode
              </AgentCardVerticalShared>
            </AgentGridRow>
          </div>
        </ScrollArea>
        <OnboardingActionsAgents
          className="mt-6"
          disabled={selected.size === 0}
          onClick={() => onContinue?.([...selected])}
        />
      </div>
    </OnboardingLayout>
  );
}
