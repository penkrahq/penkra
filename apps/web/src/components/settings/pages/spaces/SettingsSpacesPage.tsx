import { IconArchive, IconArrowRight, IconEdit, IconPlus, IconRestore } from "@tabler/icons-react";

import { Button } from "~/components/ui/button";
import { dispatchSpaceUiAction } from "~/spaceUiEvents";
import { useStore } from "~/store";
import { archiveSpace, restoreSpace } from "~/lib/spaces";
import { readNativeApi } from "~/nativeApi";

import { SettingRowShared } from "../../setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "../../settings-section-shared/SettingsSectionShared";

export function SettingsSpacesPage() {
  const spaces = useStore((store) => store.spaces);
  const archivedSpaces = useStore((store) => store.archivedSpaces);

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
                    const api = readNativeApi();
                    if (!api) return;
                    await restoreSpace({ api, spaceId: space.id });
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
    </div>
  );
}
