import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { FolderGroupShared } from "../folder-group-shared/FolderGroupShared";
import { SidebarProjects } from "../sidebar-projects/SidebarProjects";
import { SidebarTopNavigation } from "../sidebar-top-navigation/SidebarTopNavigation";
import { SpacePageShared } from "../space-page-shared/SpacePageShared";
import { WorkspaceHeaderShared } from "../workspace-header-shared/WorkspaceHeaderShared";
import { SpaceViewportShared } from "./SpaceViewportShared";

function SwipePrototype() {
  const [activePageIndex, setActivePageIndex] = useState(0);
  return (
    <SpaceViewportShared
      activePageIndex={activePageIndex}
      onActivePageIndexChange={setActivePageIndex}
    >
      {["penkra", "prototype"].map((label, index) => (
        <SpacePageShared active={activePageIndex === index} key={label} label={label}>
          <SidebarTopNavigation disabledItemIds={["new-chat", "apps", "scheduled"]} />
          <SidebarProjects>
            <WorkspaceHeaderShared>{label}</WorkspaceHeaderShared>
            <FolderGroupShared
              defaultExpanded
              label={index === 0 ? "penut" : "Research"}
              threads={[
                {
                  id: `${label}-thread`,
                  label: index === 0 ? "Main" : "Test the swipe interaction",
                  provider: index === 0 ? "claudeAgent" : "codex",
                },
              ]}
            />
          </SidebarProjects>
        </SpacePageShared>
      ))}
    </SpaceViewportShared>
  );
}

const meta = {
  component: SwipePrototype,
  decorators: [
    (Story) => (
      <div className="h-[810px] w-60">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "yc0hr", groupId: "PUf7t" } },
  title: "Left Rail/Space Viewport/Shared",
} satisfies Meta<typeof SwipePrototype>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TwoSpacePrototype: Story = {};
