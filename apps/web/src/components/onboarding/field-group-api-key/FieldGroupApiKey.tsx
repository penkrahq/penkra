import type { ChangeEventHandler } from "react";

import { InputKeyName } from "~/components/foundations/input-key-name/InputKeyName";
import { InputShared } from "~/components/foundations/input-shared/InputShared";
import { cn } from "~/lib/utils";

export interface FieldGroupApiKeyProps {
  apiKey?: string;
  className?: string;
  keyName?: string;
  onApiKeyChange?: ChangeEventHandler<HTMLInputElement>;
  onKeyNameChange?: ChangeEventHandler<HTMLInputElement>;
}

export function FieldGroupApiKey({
  apiKey,
  className,
  keyName,
  onApiKeyChange,
  onKeyNameChange,
}: FieldGroupApiKeyProps) {
  return (
    <div className={cn("flex w-[488px] flex-col gap-6", className)} data-pencil-component="YzDKb">
      <label className="flex flex-col gap-[7px]">
        <span className="text-[length:var(--app-font-size-ui-lg,13px)] font-semibold text-[var(--color-text-foreground-secondary)]">
          API key
        </span>
        <InputShared
          aria-label="API key"
          onChange={onApiKeyChange}
          placeholder="Paste API key..."
          type="password"
          value={apiKey}
        />
      </label>
      <InputKeyName aria-label="Key name" onChange={onKeyNameChange} value={keyName} />
    </div>
  );
}
