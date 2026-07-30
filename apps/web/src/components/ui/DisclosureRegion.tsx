// FILE: DisclosureRegion.tsx
// Purpose: Controlled expand/collapse region with the shared sidebar-style grid animation.
// Layer: UI primitive
// Exports: DisclosureRegion
// Depends on: disclosureMotion helpers

import type { ComponentPropsWithoutRef, ReactNode } from "react";

import {
  DISCLOSURE_INNER_CLASS,
  disclosureContentClassName,
  disclosureShellClassName,
} from "~/lib/disclosureMotion";

export function DisclosureRegion(props: {
  open: boolean;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const { open, children, className, contentClassName } = props;

  return (
    <div
      className={disclosureShellClassName(open, className)}
      aria-hidden={open ? undefined : true}
      inert={!open}
    >
      <div className={DISCLOSURE_INNER_CLASS}>
        <div className={disclosureContentClassName(open, contentClassName)}>{children}</div>
      </div>
    </div>
  );
}

export interface DisclosureSectionProps extends Omit<
  ComponentPropsWithoutRef<"section">,
  "children"
> {
  children: ReactNode;
  contentClassName?: string;
  hasContent: boolean;
  header: ReactNode;
  open: boolean;
}

export function DisclosureSection({
  children,
  contentClassName,
  hasContent,
  header,
  open,
  ...sectionProps
}: DisclosureSectionProps) {
  return (
    <section {...sectionProps}>
      {header}
      {hasContent ? (
        <DisclosureRegion contentClassName={contentClassName} open={open}>
          {children}
        </DisclosureRegion>
      ) : null}
    </section>
  );
}
