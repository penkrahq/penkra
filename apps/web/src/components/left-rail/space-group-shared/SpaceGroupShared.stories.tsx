import type { Meta, StoryObj } from "@storybook/react-vite";

import { FolderGroupShared } from "../folder-group-shared/FolderGroupShared";
import { ThreadRowShared } from "../thread-row-shared/ThreadRowShared";
import { SpaceGroupShared } from "./SpaceGroupShared";

const meta = {
  component: SpaceGroupShared,
  decorators: [
    (Story) => (
      <div className="w-56">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "U9o7S", groupId: "PUf7t", statesId: "y9eiN" } },
  title: "Left Rail/Space Group/Shared",
} satisfies Meta<typeof SpaceGroupShared>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  args: {
    label: "Personal",
    children: <ThreadRowShared>Plan the week</ThreadRowShared>,
  },
};
export const Closed: Story = {
  args: { defaultExpanded: false, label: "Work", children: <FolderGroupShared label="Projects" /> },
};
export const HeaderHover: Story = {
  args: {
    headerState: "hover",
    label: "Work",
    onHeaderAction: () => undefined,
    children: <FolderGroupShared label="Projects" />,
  },
};
