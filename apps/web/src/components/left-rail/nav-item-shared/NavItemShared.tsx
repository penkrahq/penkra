import type { ComponentProps, ReactNode } from "react";

import { LeftRailRow } from "../row-shared/LeftRailRow";

export interface NavItemSharedProps extends Omit<ComponentProps<typeof LeftRailRow>, "leading"> {
  icon: ReactNode;
}

export function NavItemShared({ icon, ...props }: NavItemSharedProps) {
  return <LeftRailRow className="h-[29px] text-sm leading-[17px]" leading={icon} {...props} />;
}
