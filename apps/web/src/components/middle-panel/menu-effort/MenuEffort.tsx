import type { ComponentProps } from "react";

import { ComposerPickerMenuPopup } from "../../chat/ComposerPickerMenuPopup";
import { cn } from "~/lib/utils";

export function MenuEffort({
  className,
  ...props
}: ComponentProps<typeof ComposerPickerMenuPopup>) {
  return (
    <ComposerPickerMenuPopup
      align="start"
      className={cn("w-[200px] min-w-[200px]", className)}
      data-pencil-component="e4cfzr"
      {...props}
    />
  );
}
