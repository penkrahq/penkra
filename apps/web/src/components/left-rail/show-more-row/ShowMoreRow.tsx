import type { ComponentProps } from "react";

import { LeftRailRow } from "../row-shared/LeftRailRow";

export type ShowMoreRowProps = ComponentProps<typeof LeftRailRow>;

export function ShowMoreRow({ children = "Show more", ...props }: ShowMoreRowProps) {
  return (
    <LeftRailRow className="pl-6" {...props}>
      {children}
    </LeftRailRow>
  );
}
