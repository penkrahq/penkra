import { IconFileDiff } from "@tabler/icons-react";

import {
  AppListRowShared,
  type AppListRowSharedProps,
} from "../app-list-row-shared/AppListRowShared";

export function OpenTabPickerRowShared({
  children = "Review",
  icon = <IconFileDiff />,
  shortcut = "^⇧G",
  ...props
}: AppListRowSharedProps) {
  return (
    <AppListRowShared
      className="min-h-8 rounded-lg px-3.5"
      icon={icon}
      shortcut={shortcut}
      {...props}
    >
      {children}
    </AppListRowShared>
  );
}
