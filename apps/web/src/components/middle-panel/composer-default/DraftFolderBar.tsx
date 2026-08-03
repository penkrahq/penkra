import { IconChevronDown, IconDeviceDesktop } from "@tabler/icons-react";
import type { ReactNode } from "react";

import { Menu, MenuTrigger } from "~/components/ui/menu";

import { MenuLocalRuntime } from "../menu-local-runtime/MenuLocalRuntime";

export function DraftFolderBar({ folderPicker }: { folderPicker: ReactNode }) {
  return (
    <div className="flex h-full min-w-0 items-center gap-1.5 overflow-visible px-2">
      {folderPicker}
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              className="inline-flex h-[26px] shrink-0 items-center gap-[7px] rounded-full px-1.5 text-[12px] font-medium text-[var(--color-text-foreground)] outline-none transition-colors hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:ring-1 focus-visible:ring-[var(--color-border-focus)]"
              data-pencil-node="B1ZyM"
            />
          }
        >
          <IconDeviceDesktop aria-hidden="true" className="size-[15px]" />
          <span>This Mac</span>
          <IconChevronDown aria-hidden="true" className="size-3" />
        </MenuTrigger>
        <MenuLocalRuntime />
      </Menu>
    </div>
  );
}
