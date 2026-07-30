import type { Meta, StoryObj } from "@storybook/react-vite";

import { FolderGroupShared } from "../folder-group-shared/FolderGroupShared";
import { SidebarProjects } from "../sidebar-projects/SidebarProjects";
import { SidebarTopNavigation } from "../sidebar-top-navigation/SidebarTopNavigation";
import { WorkspaceHeaderShared } from "../workspace-header-shared/WorkspaceHeaderShared";
import { SpacePageShared } from "./SpacePageShared";

const meta = {
  component: SpacePageShared,
  decorators: [(Story) => <div className="h-[810px] w-60"><Story /></div>],
  parameters: { pencil: { componentId: "tssws", groupId: "PUf7t" } },
  title: "Left Rail/Space Page/Shared",
} satisfies Meta<typeof SpacePageShared>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Prototype: Story = {
  args: {
    active: true,
    label: "Prototype",
    children: (
      <>
        <SidebarTopNavigation disabledItemIds={["new-chat", "apps", "scheduled"]} />
        <SidebarProjects>
          <WorkspaceHeaderShared>prototype</WorkspaceHeaderShared>
          <FolderGroupShared
            defaultExpanded
            label="Research"
            threads={[
              { id: "swipe", label: "Test the swipe interaction", provider: "claudeAgent" },
              { id: "motion", label: "Tune momentum and snapping", provider: "codex" },
            ]}
          />
        </SidebarProjects>
      </>
    ),
  },
};
