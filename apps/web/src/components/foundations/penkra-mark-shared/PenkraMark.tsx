// FILE: foundations/penkra-mark-shared/PenkraMark.tsx
// Purpose: Render the canonical Penkra mark recovered from the Pencil source of truth.
// Layer: Shared app branding primitive

import type { SVGProps } from "react";

import { cn } from "~/lib/utils";

export interface PenkraMarkProps extends SVGProps<SVGSVGElement> {
  monochrome?: boolean;
}

export function PenkraMark({ className, monochrome = false, ...props }: PenkraMarkProps) {
  const ariaLabel = props["aria-label"];
  const glyphFill = monochrome ? "currentColor" : "var(--color-brand-mark-glyph, #F5F5F7)";
  const bridgeFill = monochrome ? "currentColor" : "var(--color-brand-mark-bridge, #8CB8E1)";

  return (
    <svg
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaLabel ? undefined : true}
      {...props}
      className={cn("shrink-0", monochrome && "text-foreground", className)}
    >
      <path
        fill={glyphFill}
        d="M89 278v-67c0-91.7 74.3-166 166-166 92.2 0 167 74.3 167 166 0 88.5-70.3 160.8-158.2 163H260v-71c50.8 0 92-41.2 92-92 0-52.5-42.5-95-95-95-54.7 0-99 43.1-99 95v67H89Zm0 25h69v164H89V303Z"
      />
      <path fill={bridgeFill} d="M182 303h78v71h-78v-71Z" />
    </svg>
  );
}
