import { forwardRef, type ComponentProps } from "react";

import { InputShared } from "~/components/foundations/input-shared/InputShared";

export interface NamedInputFieldSharedProps extends ComponentProps<typeof InputShared> {
  helper?: string;
  label?: string;
}

export const NamedInputFieldShared = forwardRef<HTMLInputElement, NamedInputFieldSharedProps>(
  function NamedInputFieldShared(
    { helper = "Saved automatically", label = "Display name", ...props },
    ref,
  ) {
    return (
      <label className="flex w-full flex-col gap-2 font-sans">
        <span className="text-[13px] font-semibold text-[var(--color-text-foreground-secondary)]">
          {label}
        </span>
        <InputShared ref={ref} {...props} />
        <span className="text-xs text-[var(--color-text-foreground-tertiary)]">{helper}</span>
      </label>
    );
  },
);
