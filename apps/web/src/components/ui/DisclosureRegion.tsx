// FILE: DisclosureRegion.tsx
// Purpose: Controlled expand/collapse region with shared intrinsic-height motion.
// Layer: UI primitive
// Exports: DisclosureRegion
// Depends on: disclosureMotion helpers

import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  type TransitionEvent,
  useLayoutEffect,
  useReducer,
  useRef,
} from "react";

import {
  DISCLOSURE_INNER_CLASS,
  DISCLOSURE_INTRINSIC_SIZE_STYLE,
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
  const lastOpenChildrenRef = useRef(children);
  const [, releaseRetainedChildren] = useReducer((version: number) => version + 1, 0);

  // A controlling parent may stop deriving a large disclosure's rows as soon as it closes.
  // Keep the last committed open content long enough for `height: auto -> 0` to have a real
  // starting size. This is lifecycle-driven by transitionend, not a duration or row-count timer.
  useLayoutEffect(() => {
    if (open) {
      lastOpenChildrenRef.current = children;
      return;
    }

    // Reduced-motion removes the transition, so there is no transitionend to release on.
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches &&
      lastOpenChildrenRef.current !== children
    ) {
      lastOpenChildrenRef.current = children;
      releaseRetainedChildren();
    }
  }, [children, open]);

  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (
      open ||
      event.target !== event.currentTarget ||
      event.propertyName !== "height" ||
      lastOpenChildrenRef.current === children
    ) {
      return;
    }

    lastOpenChildrenRef.current = children;
    releaseRetainedChildren();
  };

  const renderedChildren = open ? children : lastOpenChildrenRef.current;

  return (
    <div
      className={disclosureShellClassName(open, className)}
      aria-hidden={open ? undefined : true}
      data-slot="disclosure-region"
      inert={!open}
      onTransitionEnd={handleTransitionEnd}
      style={DISCLOSURE_INTRINSIC_SIZE_STYLE}
    >
      <div className={DISCLOSURE_INNER_CLASS}>
        <div className={disclosureContentClassName(open, contentClassName)}>{renderedChildren}</div>
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
        <DisclosureRegion
          {...(contentClassName === undefined ? {} : { contentClassName })}
          open={open}
        >
          {children}
        </DisclosureRegion>
      ) : null}
    </section>
  );
}
