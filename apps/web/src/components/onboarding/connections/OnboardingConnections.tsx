import { ButtonBack } from "~/components/foundations/button-back/ButtonBack";

import { ConnectionMethodList } from "../connection-method-list/ConnectionMethodList";
import { ConnectionsList } from "../connections-list/ConnectionsList";
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
        <p className="mt-2 text-[length:calc(var(--app-font-size-base,12px)*1.1667)] text-[var(--color-text-foreground-secondary)]">
          Add or remove providers and API keys.
        </p>
        <ConnectionsList className="mt-6" />
        <ConnectionMethodList
          className="mt-6"
          {...(onEnterApiKey === undefined ? {} : { onEnterApiKey })}
          {...(onSignIn === undefined ? {} : { onSignIn })}
        />
      </div>
    </OnboardingLayout>
  );
}
