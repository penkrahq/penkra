import { useState } from "react";

import { ButtonBack } from "~/components/foundations/button-back/ButtonBack";
import { ButtonPrimary } from "~/components/foundations/button-primary/ButtonPrimary";
import { InputKeyName } from "~/components/foundations/input-key-name/InputKeyName";
import { InputShared } from "~/components/foundations/input-shared/InputShared";

import { OnboardingLayout } from "../shared/OnboardingLayout";

export interface OnboardingApiKeyProps {
  onBack?: () => void;
  onContinue?: (key: string, name: string) => void;
}

export function OnboardingApiKey({ onBack, onContinue }: OnboardingApiKeyProps) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");

  return (
    <OnboardingLayout>
      <ButtonBack className="absolute top-7 left-7" onClick={onBack} />
      <div className="w-[488px] font-sans" data-pencil-component="kCRIp">
        <h1 className="text-2xl font-semibold">Enter your API key</h1>
        <p className="mt-2 text-sm text-[var(--color-text-foreground-secondary)]">
          Paste your key to connect directly.
        </p>
        <div className="mt-6 flex flex-col gap-4">
          <label className="flex flex-col gap-[7px]">
            <span className="text-[13px] font-semibold">API key</span>
            <InputShared
              aria-label="API key"
              onChange={(event) => setKey(event.target.value)}
              placeholder="Paste API key..."
              type="password"
              value={key}
            />
          </label>
          <InputKeyName
            aria-label="Key name"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </div>
        <ButtonPrimary
          className="mt-6"
          disabled={!key}
          onClick={() => onContinue?.(key, name)}
        >
          Continue
        </ButtonPrimary>
      </div>
    </OnboardingLayout>
  );
}
