import { useState } from "react";

import { ButtonBack } from "~/components/foundations/button-back/ButtonBack";
import { ButtonSave } from "~/components/foundations/button-save/ButtonSave";

import { FieldGroupApiKey } from "../field-group-api-key/FieldGroupApiKey";
import { NoticeSecurity } from "../notice-security/NoticeSecurity";
import { onboardingIllustrations, OnboardingLayout } from "../shared/OnboardingLayout";

export interface OnboardingApiKeyProps {
  onBack?: () => void;
  onContinue?: (key: string, name: string) => void;
}

export function OnboardingApiKey({ onBack, onContinue }: OnboardingApiKeyProps) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");

  return (
    <OnboardingLayout brandImage={onboardingIllustrations.apiKey}>
      <ButtonBack className="absolute top-7 left-7" onClick={onBack} />
      <div className="w-[488px] font-sans" data-pencil-component="kCRIp">
        <h1 className="text-2xl font-semibold">Enter your API key</h1>
        <p className="mt-2 text-sm text-[var(--color-text-foreground-secondary)]">
          Paste your key to connect directly.
        </p>
        <FieldGroupApiKey
          apiKey={key}
          className="mt-6"
          keyName={name}
          onApiKeyChange={(event) => setKey(event.target.value)}
          onKeyNameChange={(event) => setName(event.target.value)}
        />
        <ButtonSave className="mt-6" disabled={!key} onClick={() => onContinue?.(key, name)} />
        <NoticeSecurity className="mt-3" />
      </div>
    </OnboardingLayout>
  );
}
