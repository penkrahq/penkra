import type { Meta, StoryObj } from "@storybook/react-vite";

import { SpaceHeaderShared } from "./SpaceHeaderShared";

const meta = {
  component: SpaceHeaderShared,
  decorators: [
    (Story) => (
      <div className="w-56">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "mI4rI", groupId: "PUf7t", statesId: "N0dG2o" } },
  title: "Left Rail/Space Header/Shared",
} satisfies Meta<typeof SpaceHeaderShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Hover: Story = { args: { onAction: () => undefined, state: "hover" } };
export const Active: Story = { args: { onAction: () => undefined, state: "active" } };
export const Closed: Story = { args: { expanded: false } };
export const Disabled: Story = { args: { disabled: true } };
