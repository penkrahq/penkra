import { IconPackage } from "@tabler/icons-react";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "~/lib/utils";

export interface IconTileAppProps extends HTMLAttributes<HTMLSpanElement> {
  icon?: ReactNode;
  tone?: "blue" | "green" | "orange" | "purple" | "slate";
}

const toneClasses = {
  blue: "bg-[#4a90e2]",
  green: "bg-[#1d6f42]",
  orange: "bg-[#ea7600]",
  purple: "bg-[#a259ff]",
  slate: "bg-[#2a2e37]",
};

export function IconTileApp({
  className,
  icon = <IconPackage />,
  tone = "blue",
  ...props
}: IconTileAppProps) {
  return (
    <span
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center rounded-[10px] text-white [&_svg]:size-5",
        toneClasses[tone],
        className,
      )}
      data-pencil-component="hqS2K"
      {...props}
    >
      {icon}
    </span>
  );
}
