// FILE: SynaraLogo.tsx
// Purpose: Render the Penkra mark as an inline SVG that follows theme foreground color.
// Layer: Shared app branding primitive

import type { SVGProps } from "react";
import { SYNARA_LOGO_PATHS } from "~/assets/synaraLogoPath";
import { cn } from "~/lib/utils";

export function SynaraLogo({ className, ...props }: SVGProps<SVGSVGElement>) {
  const ariaLabel = props["aria-label"];

  return (
    <svg
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaLabel ? undefined : true}
      {...props}
      className={cn("shrink-0 text-foreground", className)}
    >
      {SYNARA_LOGO_PATHS.map((path) => (
        <path
          key={path}
          d={path}
          fill="currentColor"
          transform="translate(-2890 -2355) scale(27.5)"
        />
      ))}
    </svg>
  );
}
