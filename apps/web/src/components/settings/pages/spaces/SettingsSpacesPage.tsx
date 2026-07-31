import { IconArrowRight, IconEdit, IconPlus } from "@tabler/icons-react";

import { Button } from "~/components/ui/button";
import { dispatchSpaceUiAction } from "~/spaceUiEvents";
import { useStore } from "~/store";

import { SettingRowShared } from "../../setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "../../settings-section-shared/SettingsSectionShared";

export function SettingsSpacesPage() {
  const spaces = useStore((store) => store.spaces);

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
      <Button
        className="self-start"
        onClick={() => dispatchSpaceUiAction({ type: "create" })}
        size="sm"
        variant="outline"
      >
        <IconPlus />
        New Space
      </Button>
    </div>
  );
}
