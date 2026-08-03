import { IconCircle } from "@tabler/icons-react";
import { useState } from "react";

import { PopoverQuickSettings } from "~/components/middle-panel/popover-quick-settings/PopoverQuickSettings";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export function ComposerQuickSettings({ onSelect }: { onSelect: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  aria-label="Change mode"
                  className="!size-[26px] shrink-0 rounded-full p-0 text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)] sm:!size-[26px] [&_svg]:mx-0"
                  size="icon-sm"
                  variant="chrome"
                />
              }
            />
          }
        >
          <IconCircle aria-hidden="true" className="!size-[13px]" stroke={1.75} />
        </TooltipTrigger>
        {!open ? <TooltipPopup side="top">Change mode</TooltipPopup> : null}
      </Tooltip>
      <PopoverPopup
        align="end"
        className="border-0 bg-transparent p-0 shadow-none [&_[data-slot=popover-viewport]]:p-0"
        side="top"
        sideOffset={8}
      >
        <PopoverQuickSettings
          onSelect={() => {
            setOpen(false);
            onSelect();
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}
