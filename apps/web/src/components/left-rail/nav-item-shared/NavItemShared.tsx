import type { ComponentProps, ReactNode } from "react";

import { LeftRailRow } from "../row-shared/LeftRailRow";

export interface NavItemSharedProps extends Omit<ComponentProps<typeof LeftRailRow>, "leading"> {
  icon: ReactNode;
}

export function NavItemShared({ icon, ...props }: NavItemSharedProps) {
  return (
    <LeftRailRow
      className="h-[29px] gap-2.5 text-[length:calc(var(--app-font-size-base,12px)*1.1667)] leading-[17px]"
      leading={icon}
      leadingClassName="size-4 [&_svg]:size-4"
      {...props}
    />
  );
}
