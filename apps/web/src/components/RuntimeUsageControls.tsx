// FILE: RuntimeUsageControls.tsx
// Purpose: Composer permission picker, independent of the removed Git environment toolbar.

import type { RuntimeMode } from "@penkra/contracts";
import { ChevronDownIcon } from "~/lib/icons";
import { HiOutlineHandRaised } from "react-icons/hi2";
import { useState } from "react";

import { cn } from "../lib/utils";
import type { ContextWindowSnapshot } from "../lib/contextWindow";
import {
  RUNTIME_FULL_ACCESS_ACCENT_CLASS_NAME,
  COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
} from "./chat/composerPickerStyles";
import { ComposerPickerMenu, ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { AccessPillContent } from "./middle-panel/access-pill-content/AccessPillContent";
import { Button } from "./ui/button";
import { MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface RuntimeUsageControlsProps {
  runtimeMode?: RuntimeMode | undefined;
  onRuntimeModeChange?: ((mode: RuntimeMode) => void) | undefined;
  contextWindow?: ContextWindowSnapshot | null | undefined;
  cumulativeCostUsd?: number | null | undefined;
  activeContextWindowLabel?: string | null | undefined;
  pendingContextWindowLabel?: string | null | undefined;
  className?: string | undefined;
  hideLabel?: boolean | undefined;
}

export function RuntimeUsageControls({
  runtimeMode,
  onRuntimeModeChange,
  className,
  hideLabel: hideLabelProp,
}: RuntimeUsageControlsProps) {
  const hideLabel = hideLabelProp ?? false;
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-[var(--color-text-foreground-secondary)]",
        className,
      )}
    >
      {runtimeMode && onRuntimeModeChange ? (
        <ComposerPickerMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      size="sm"
                      variant="chrome"
                      className={cn(
                        "!h-[26px] min-w-0 shrink-0 justify-start gap-1 whitespace-nowrap rounded-full px-1.5 font-normal sm:!h-[26px] sm:px-1.5 [&_svg]:mx-0",
                        COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
                        runtimeMode === "full-access" && RUNTIME_FULL_ACCESS_ACCENT_CLASS_NAME,
                      )}
                      aria-label={
                        runtimeMode === "full-access" ? "Full access permissions" : "Permissions"
                      }
                      data-pencil-component="iP6oE"
                    />
                  }
                />
              }
            >
              {runtimeMode === "full-access" ? (
                <AccessPillContent hideLabel={hideLabel} />
              ) : (
                <span className="inline-flex items-center gap-1">
                  <HiOutlineHandRaised className="size-[13px] shrink-0" />
                  <span className={cn("truncate", hideLabel ? "sr-only" : "@max-[480px]:sr-only")}>
                    Default permissions
                  </span>
                  <ChevronDownIcon
                    className={cn(
                      "size-[11px] shrink-0 opacity-70",
                      hideLabel ? "hidden" : "@max-[480px]:hidden",
                    )}
                  />
                </span>
              )}
            </TooltipTrigger>
            {!menuOpen ? <TooltipPopup side="top">Permissions</TooltipPopup> : null}
          </Tooltip>
          <ComposerPickerMenuPopup align="start" side="top" className="min-w-44">
            <MenuRadioGroup
              value={runtimeMode}
              onValueChange={(value) => {
                if (
                  !value ||
                  (value !== "full-access" && value !== "approval-required") ||
                  value === runtimeMode
                ) {
                  return;
                }
                onRuntimeModeChange(value);
              }}
            >
              <MenuRadioItem
                value="full-access"
                className="data-checked:text-[var(--runtime-full-access-accent)]"
              >
                <span className="inline-flex items-center gap-2">
                  <AccessPillContent hideLabel />
                  Full access
                </span>
              </MenuRadioItem>
              <MenuRadioItem value="approval-required">
                <span className="inline-flex items-center gap-2">
                  <HiOutlineHandRaised className="size-4 shrink-0" />
                  Default permissions
                </span>
              </MenuRadioItem>
            </MenuRadioGroup>
          </ComposerPickerMenuPopup>
        </ComposerPickerMenu>
      ) : null}
    </div>
  );
}
