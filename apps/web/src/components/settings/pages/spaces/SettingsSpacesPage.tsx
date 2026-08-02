import { IconArchive, IconArrowRight, IconEdit, IconPlus, IconRestore } from "@tabler/icons-react";
import { useState } from "react";

import { RenameDialog } from "~/components/RenameDialog";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { dispatchSpaceUiAction } from "~/spaceUiEvents";
import { useStore } from "~/store";
import type { Space } from "~/types";
import { archiveSpace, restoreSpace } from "~/lib/spaces";
import { readNativeApi } from "~/nativeApi";

import { SettingRowShared } from "../../setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "../../settings-section-shared/SettingsSectionShared";

export function SettingsSpacesPage() {
  const spaces = useStore((store) => store.spaces);
  const archivedSpaces = useStore((store) => store.archivedSpaces);
  const [restoreRenameSpace, setRestoreRenameSpace] = useState<Space | null>(null);

  const restore = async (space: Space, name?: string) => {
    const api = readNativeApi();
    if (!api) return;
    try {
      await restoreSpace({ api, spaceId: space.id, ...(name ? { name } : {}) });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to restore Space",
        description: error instanceof Error ? error.message : "Try again.",
      });
      throw error;
    }
  };

  return (
    <div className="flex flex-col gap-6" data-pencil-page="spaces">
      <SettingsSectionShared title="Your Spaces">
        {spaces.map((space) => (
          <SettingRowShared
            control={
              <div className="flex items-center gap-1.5">
                <Button
                  aria-label={`Rename ${space.name}`}
                  onClick={() => dispatchSpaceUiAction({ type: "rename", spaceId: space.id })}
                  size="icon-xs"
                  variant="ghost"
                >
                  <IconEdit />
                </Button>
                <Button
                  aria-label={`Archive ${space.name}`}
                  onClick={async () => {
                    const api = readNativeApi();
                    if (!api) return;
                    await archiveSpace({ api, spaceId: space.id });
                  }}
                  size="icon-xs"
                  variant="ghost"
                >
                  <IconArchive />
                </Button>
                <Button
                  aria-label={`Show ${space.name} in the left rail`}
                  onClick={() => dispatchSpaceUiAction({ type: "focus", spaceId: space.id })}
                  size="icon-xs"
                  variant="ghost"
                >
                  <IconArrowRight />
                </Button>
              </div>
            }
            description="Folders and threads assigned to this Space appear together in the left rail."
            key={space.id}
            label={space.name}
          />
        ))}
      </SettingsSectionShared>
      {archivedSpaces.length > 0 ? (
        <SettingsSectionShared title="Archived Spaces">
          {archivedSpaces.map((space) => (
            <SettingRowShared
              control={
                <Button
                  aria-label={`Restore ${space.name}`}
                  onClick={async () => {
                    const normalizedName = space.name.trim().toLowerCase();
                    const hasActiveNameConflict = spaces.some(
                      (activeSpace) => activeSpace.name.trim().toLowerCase() === normalizedName,
                    );
                    if (hasActiveNameConflict) {
                      setRestoreRenameSpace(space);
                      return;
                    }
                    await restore(space);
                  }}
                  size="icon-xs"
                  variant="ghost"
                >
                  <IconRestore />
                </Button>
              }
              description="Restore this Space with its folders and threads unchanged."
              key={space.id}
              label={space.name}
            />
          ))}
        </SettingsSectionShared>
      ) : null}
      <Button
        className="self-start"
        onClick={() => dispatchSpaceUiAction({ type: "create" })}
        size="sm"
        variant="outline"
      >
        <IconPlus />
        New Space
      </Button>
      <RenameDialog
        open={restoreRenameSpace !== null}
        title={
          restoreRenameSpace ? `Rename and restore ${restoreRenameSpace.name}` : "Restore Space"
        }
        description="An active Space already uses this name. Choose a different name to restore it with its folders and threads unchanged."
        initialValue={restoreRenameSpace ? `${restoreRenameSpace.name} restored` : ""}
        saveLabel="Restore"
        onOpenChange={(open) => {
          if (!open) setRestoreRenameSpace(null);
        }}
        onSave={async (name) => {
          if (!restoreRenameSpace) return;
          await restore(restoreRenameSpace, name);
        }}
      />
    </div>
  );
}
