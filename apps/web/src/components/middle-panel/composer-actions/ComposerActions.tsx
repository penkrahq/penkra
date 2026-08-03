import { IconCircle, IconMicrophone, IconPlus } from "@tabler/icons-react";
import type { ReactNode } from "react";

import { IconActionTooltip } from "~/components/foundations/icon-action-tooltip/IconActionTooltip";

import { AccessPillTrigger } from "../access-pill-trigger/AccessPillTrigger";
import { ButtonSend } from "../button-send/ButtonSend";
import { HarnessSelectorShared } from "../harness-selector-shared/HarnessSelectorShared";

export interface ComposerActionsProps {
  applicationLeading?: ReactNode;
  applicationTrailing?: ReactNode;
  applicationTrailingExpands?: boolean;
  disabled?: boolean;
  onAccess?: () => void;
  onAttach?: () => void;
  onMode?: () => void;
  onVoice?: () => void;
  pencilComponentId?: "JwTiI" | "BtaMG";
  showHarness?: boolean;
}

export function ComposerActions({
  applicationLeading,
  applicationTrailing,
  applicationTrailingExpands = false,
  disabled = false,
  onAccess,
  onAttach,
  onMode,
  onVoice,
  pencilComponentId = "JwTiI",
  showHarness = true,
}: ComposerActionsProps) {
  if (applicationLeading !== undefined || applicationTrailing !== undefined) {
    return (
      <div
        className="flex h-[26px] w-full min-w-0 items-center gap-1"
        data-pencil-component={pencilComponentId}
      >
        {applicationLeading ? (
          <div className="flex min-w-0 shrink items-center gap-1">{applicationLeading}</div>
        ) : null}
        <span className="min-w-0 flex-1" />
        {applicationTrailing ? (
          <div
            className={
              applicationTrailingExpands
                ? "flex min-w-0 flex-1 items-center gap-1"
                : "flex shrink-0 items-center gap-1"
            }
          >
            {applicationTrailing}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="flex h-[26px] w-full items-center gap-1"
      data-pencil-component={pencilComponentId}
    >
      <IconActionTooltip
        ariaLabel="Attach files"
        label="Attach files"
        shortcut=""
        {...(onAttach === undefined ? {} : { onClick: onAttach })}
      >
        <IconPlus />
      </IconActionTooltip>
      <AccessPillTrigger onClick={onAccess} />
      <span className="min-w-2 flex-1" />
      {showHarness ? <HarnessSelectorShared /> : null}
      <IconActionTooltip
        ariaLabel="Change mode"
        label="Change mode"
        shortcut=""
        {...(onMode === undefined ? {} : { onClick: onMode })}
      >
        <IconCircle className="size-[13px]" />
      </IconActionTooltip>
      <IconActionTooltip
        ariaLabel="Voice input"
        label="Voice input"
        shortcut=""
        {...(onVoice === undefined ? {} : { onClick: onVoice })}
      >
        <IconMicrophone />
      </IconActionTooltip>
      <ButtonSend disabled={disabled} />
    </div>
  );
}
