import type { HTMLAttributes } from "react";

import { cn } from "~/lib/utils";

export interface TrafficLightAffordanceProps extends HTMLAttributes<HTMLDivElement> {
  fullscreen?: boolean;
}

export function TrafficLightAffordance({
  className,
  fullscreen = false,
  ...props
}: TrafficLightAffordanceProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex h-[46px] w-[90px] items-center gap-2 px-4",
        fullscreen && "invisible",
        className,
      )}
      data-window-state={fullscreen ? "fullscreen" : "windowed"}
      {...props}
    >
      <span className="size-3.5 rounded-full bg-[#ff5f57]" />
      <span className="size-3.5 rounded-full bg-[#febc2e]" />
      <span className="size-3.5 rounded-full bg-[#28c840]" />
    </div>
  );
}
