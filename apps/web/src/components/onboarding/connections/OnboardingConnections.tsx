import { ButtonBack } from "~/components/foundations/button-back/ButtonBack";
import { ButtonSecondary } from "~/components/foundations/button-secondary/ButtonSecondary";
import { ButtonSignInWithClaude } from "~/components/foundations/button-sign-in-with-claude/ButtonSignInWithClaude";

import { ConnectionRowShared } from "../connection-row-shared/ConnectionRowShared";
import { OnboardingLayout } from "../shared/OnboardingLayout";

export interface OnboardingConnectionsProps {
  onBack?: () => void;
  onEnterApiKey?: () => void;
  onSignIn?: () => void;
}

export function OnboardingConnections({
  onBack,
  onEnterApiKey,
  onSignIn,
}: OnboardingConnectionsProps) {
  return (
    <OnboardingLayout>
      <ButtonBack className="absolute top-7 left-7" onClick={onBack} />
      <div className="w-[488px] font-sans" data-pencil-component="J3rDs">
        <h1 className="text-2xl font-semibold">Manage your connections</h1>
        <p className="mt-2 text-sm text-[var(--color-text-foreground-secondary)]">
          Add or remove providers and API keys.
        </p>
        <div className="mt-6">
          <ConnectionRowShared />
          <ConnectionRowShared detail="Shared workspace" label="team@example.com" />
          <ConnectionRowShared detail="API key" label="Production key" />
        </div>
        <div className="mt-6 flex flex-col gap-2.5">
          <ButtonSignInWithClaude onClick={onSignIn} />
          <ButtonSecondary onClick={onEnterApiKey}>Enter API key</ButtonSecondary>
        </div>
      </div>
    </OnboardingLayout>
  );
}
