import type { Meta, StoryObj } from "@storybook/react-vite";

import { FolderRowShared } from "./FolderRowShared";

const meta = {
  component: FolderRowShared,
  decorators: [
    (Story) => (
      <div className="w-56">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "D2SV3", groupId: "PUf7t", statesId: "N0dG2o" } },
  title: "Left Rail/Folder Row/Shared",
} satisfies Meta<typeof FolderRowShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Hover: Story = { args: { state: "hover" } };
export const Open: Story = { args: { expanded: true } };
export const OpenHover: Story = { args: { expanded: true, state: "hover" } };
export const Selected: Story = { args: { state: "selected" } };
export const Disabled: Story = { args: { disabled: true } };
