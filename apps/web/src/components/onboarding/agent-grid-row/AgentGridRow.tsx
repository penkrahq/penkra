import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface AgentGridRowProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function AgentGridRow({ children, className, ...props }: AgentGridRowProps) {
  return (
    <div
      className={cn("flex h-[130px] w-[488px] gap-3", className)}
      data-pencil-component="cnSNP"
      {...props}
    >
      {children}
    </div>
  );
}
