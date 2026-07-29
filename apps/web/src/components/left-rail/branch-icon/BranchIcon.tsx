import { IconGitBranch } from "@tabler/icons-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

export interface BranchIconProps extends ComponentProps<typeof IconGitBranch> {}

export function BranchIcon({ className, ...props }: BranchIconProps) {
  return (
    <IconGitBranch
      aria-hidden="true"
      className={cn("size-3.5 shrink-0", className)}
      {...props}
    />
  );
}
