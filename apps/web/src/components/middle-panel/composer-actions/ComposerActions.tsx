import { IconCircle, IconMicrophone, IconPlus } from "@tabler/icons-react";

import { IconActionTooltip } from "~/components/foundations/icon-action-tooltip/IconActionTooltip";

import { AccessPillTrigger } from "../access-pill-trigger/AccessPillTrigger";
import { ButtonSend } from "../button-send/ButtonSend";
import { HarnessSelectorShared } from "../harness-selector-shared/HarnessSelectorShared";

export interface ComposerActionsProps {
  disabled?: boolean;
  onAccess?: () => void;
  onAttach?: () => void;
  onMode?: () => void;
  onVoice?: () => void;
  showHarness?: boolean;
}

export function ComposerActions({
  disabled = false,
  onAccess,
  onAttach,
  onMode,
  onVoice,
  showHarness = false,
}: ComposerActionsProps) {
  return (
    <div className="flex h-[26px] w-full items-center" data-pencil-component="JwTiI">
      <IconActionTooltip
        ariaLabel="Attach files"
        label="Attach files"
        onClick={onAttach}
        shortcut=""
      >
        <IconPlus />
      </IconActionTooltip>
      <AccessPillTrigger onClick={onAccess} />
      <span className="min-w-2 flex-1" />
      {showHarness ? <HarnessSelectorShared /> : null}
      <IconActionTooltip ariaLabel="Change mode" label="Change mode" onClick={onMode} shortcut="">
        <IconCircle className="size-[13px]" />
      </IconActionTooltip>
      <IconActionTooltip ariaLabel="Voice input" label="Voice input" onClick={onVoice} shortcut="">
        <IconMicrophone />
      </IconActionTooltip>
      <ButtonSend disabled={disabled} />
    </div>
  );
}
