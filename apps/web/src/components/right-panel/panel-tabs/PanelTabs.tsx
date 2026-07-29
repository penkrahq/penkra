import { IconFileDiff, IconFileText } from "@tabler/icons-react";

import { PanelTabShared } from "../panel-tab-shared/PanelTabShared";

export interface PanelTabsProps {
  activeTab?: "files" | "review";
  onSelect?: (tab: "files" | "review") => void;
}

export function PanelTabs({ activeTab = "files", onSelect }: PanelTabsProps) {
  return (
    <div className="flex h-10 w-full items-end gap-1 px-2" role="tablist">
      <PanelTabShared
        active={activeTab === "files"}
        icon={<IconFileText />}
        onClick={() => onSelect?.("files")}
      >
        Files
      </PanelTabShared>
      <PanelTabShared
        active={activeTab === "review"}
        icon={<IconFileDiff />}
        onClick={() => onSelect?.("review")}
      >
        Review
      </PanelTabShared>
    </div>
  );
}
