import type { Meta, StoryObj } from "@storybook/react-vite";

import { SidebarFolders } from "../sidebar-folders/SidebarFolders";
import { SidebarTopNavigation } from "../sidebar-top-navigation/SidebarTopNavigation";
import { SpaceGroupShared } from "../space-group-shared/SpaceGroupShared";
import { LeftRailContentShared } from "./LeftRailContentShared";

const meta = {
  component: LeftRailContentShared,
  decorators: [
    (Story) => (
      <div className="h-[810px] w-60">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "tssws", groupId: "PUf7t" } },
  title: "Left Rail/Left Rail Content/Shared",
} satisfies Meta<typeof LeftRailContentShared>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: (
      <>
        <SidebarTopNavigation disabledItemIds={["apps", "scheduled"]} />
        <SidebarFolders>
          <SpaceGroupShared expanded label="Personal" />
        </SidebarFolders>
      </>
    ),
  },
};
