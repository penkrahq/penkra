import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { ButtonBack } from "~/components/foundations/button-back/ButtonBack";
import { SettingsAgentsPage } from "~/components/settings/pages/agents/SettingsAgentsPage";
import { ScrollArea } from "~/components/ui/scroll-area";

import { OnboardingActionsAgents } from "../onboarding-actions-agents/OnboardingActionsAgents";
import { onboardingIllustrations, OnboardingLayout } from "../shared/OnboardingLayout";

export interface OnboardingConnectAgentProps {
  onBack?: () => void;
  onContinue?: () => void;
}

export function OnboardingConnectAgent({ onBack, onContinue }: OnboardingConnectAgentProps) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <OnboardingLayout brandImage={onboardingIllustrations.connectAgent}>
        <ButtonBack className="absolute top-7 left-7" onClick={onBack} />
        <div className="w-[488px] font-sans" data-pencil-component="X4Yqda">
          <h1 className="text-2xl font-semibold">Connect your agents</h1>
          <p className="mt-2 text-[length:calc(var(--app-font-size-base,12px)*1.1667)] text-[var(--color-text-foreground-secondary)]">
            Add Connections now, or continue and use OpenCode’s free models.
          </p>
          <ScrollArea
            aria-label="Agent Connections"
            className="mt-6 h-[340px] pr-1"
            hideScrollbars
            scrollFade
          >
            <SettingsAgentsPage embedded />
          </ScrollArea>
          <OnboardingActionsAgents className="mt-6" onClick={() => onContinue?.()} />
        </div>
      </OnboardingLayout>
    </QueryClientProvider>
  );
}
