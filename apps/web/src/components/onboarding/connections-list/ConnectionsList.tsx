import type { HTMLAttributes } from "react";

import { cn } from "~/lib/utils";

import { ConnectionRowShared } from "../connection-row-shared/ConnectionRowShared";

export function ConnectionsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex w-[488px] flex-col gap-2", className)}
      data-pencil-component="EU9Dz"
      {...props}
    >
      <ConnectionRowShared />
      <ConnectionRowShared detail="Shared workspace" label="team@example.com" />
      <ConnectionRowShared detail="API key" label="Production key" />
    </div>
  );
}
