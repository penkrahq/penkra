// FILE: QueuedComposerActions.tsx
// Purpose: Inline action cluster (Steer / Delete / Menu) rendered on each queued
// composer row. Used in both the compact and expanded composer layouts so the
// action chrome stays in lockstep across surfaces.
// Layer: Chat composer UI primitive
// Exports: QueuedComposerActions

import { EllipsisIcon, SteerIcon, Trash2 } from "~/lib/icons";

import type { QueuedComposerTurn } from "../../composerDraftStore";

import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { MenuItem, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenu, ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";

type QueuedComposerActionsProps = {
  queuedTurn: QueuedComposerTurn;
  busy?: boolean;
  onSteer: (queuedTurn: QueuedComposerTurn) => void;
  onRemove: (queuedTurn: QueuedComposerTurn) => void;
  onEdit: (queuedTurn: QueuedComposerTurn) => void;
};

function QueuedComposerActions({
  queuedTurn,
  busy = false,
  onSteer,
  onRemove,
  onEdit,
}: QueuedComposerActionsProps) {
  return (
    <div className="flex shrink-0 items-center gap-0" aria-busy={busy || undefined}>
      <Button variant="subtle" size="chip" disabled={busy} onClick={() => void onSteer(queuedTurn)}>
        <SteerIcon />
        <span>Steer</span>
      </Button>
      <IconButton
        variant="ghost"
        size="icon-chip"
        label="Delete queued follow-up"
        disabled={busy}
        onClick={() => onRemove(queuedTurn)}
      >
        <Trash2 />
      </IconButton>
      <ComposerPickerMenu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-chip"
              aria-label="Queued follow-up actions"
              disabled={busy}
              className="[&_svg]:mx-0"
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="end" side="top" sideOffset={6}>
          <MenuItem disabled={busy} onClick={() => onEdit(queuedTurn)}>
            Edit queued prompt
          </MenuItem>
          <MenuItem disabled={busy} onClick={() => onRemove(queuedTurn)}>
            Delete queued prompt
          </MenuItem>
        </ComposerPickerMenuPopup>
      </ComposerPickerMenu>
    </div>
  );
}

export { QueuedComposerActions };
