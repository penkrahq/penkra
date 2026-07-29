import type { Meta, StoryObj } from "@storybook/react-vite";

import { WorkspaceHeaderShared } from "./WorkspaceHeaderShared";

const meta = {
  component: WorkspaceHeaderShared,
  decorators: [(Story) => <div className="w-56"><Story /></div>],
  parameters: { pencil: { componentId: "mI4rI", groupId: "PUf7t", statesId: "N0dG2o" } },
  title: "Left Rail/Workspace Header/Shared",
} satisfies Meta<typeof WorkspaceHeaderShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Open: Story = {};
export const Closed: Story = { args: { expanded: false } };
export const Disabled: Story = { args: { disabled: true } };
