import type { ReactNode } from "react";

export function ConnectionSetupShared({
  body,
  children,
  title,
}: {
  readonly body?: string;
  readonly children: ReactNode;
  readonly title?: string;
}) {
  return (
    <div
      className="space-y-3.5 rounded-[10px] bg-[var(--color-background-button-secondary)] px-[18px] py-5"
      data-pencil-component="Byt2h"
    >
      {title ? (
        <div className="space-y-1">
          <p className="text-[13px] font-semibold text-[var(--color-text-foreground)]">{title}</p>
          {body ? (
            <p className="text-[length:var(--app-font-size-ui,12px)] leading-[1.4] text-[var(--color-text-foreground-secondary)]">
              {body}
            </p>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
