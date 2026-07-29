import { forwardRef, type ComponentProps } from "react";

import { InputShared } from "../input-shared/InputShared";

export interface InputKeyNameProps extends ComponentProps<typeof InputShared> {
  label?: string;
}

export const InputKeyName = forwardRef<HTMLInputElement, InputKeyNameProps>(function InputKeyName(
  { label = "Key name (Optional)", leadingIcon, placeholder = "Enter value...", ...props },
  ref,
) {
  return (
    <label className="flex w-full flex-col gap-[7px]">
      <span className="font-sans text-[13px] leading-4 font-semibold text-[var(--pencil-text-secondary)]">
        {label}
      </span>
      <InputShared
        leadingIcon={leadingIcon ?? <KeyIcon />}
        placeholder={placeholder}
        ref={ref}
        {...props}
      />
    </label>
  );
});

function KeyIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m12 12 9-9m-3 3 3 3m-6 0 3 3" />
    </svg>
  );
}
