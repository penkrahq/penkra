import { IconCheck, IconDeviceDesktop } from "@tabler/icons-react";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { MenuItem } from "~/components/ui/menu";

export function MenuLocalRuntime() {
  return (
    <ComposerPickerMenuPopup
      align="start"
      side="top"
      sideOffset={6}
      className="w-40 min-w-40 rounded-[10px] p-2"
      data-pencil-component="DJLI5"
    >
      <MenuItem className="h-8 gap-2 rounded-lg px-2 py-0 text-[length:var(--app-font-size-ui,12px)] font-normal">
        <IconDeviceDesktop
          aria-hidden="true"
          className="size-[15px] text-[var(--color-text-foreground-secondary)]"
        />
        <span className="min-w-0 flex-1 truncate text-[var(--color-text-foreground-secondary)]">
          This Mac
        </span>
        <IconCheck aria-hidden="true" className="size-3.5 text-[var(--color-accent-blue)]" />
      </MenuItem>
    </ComposerPickerMenuPopup>
  );
}
