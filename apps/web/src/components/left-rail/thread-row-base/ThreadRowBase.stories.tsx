import type { Meta, StoryObj } from "@storybook/react-vite";

import { ThreadRowBase } from "./ThreadRowBase";

const meta = {
  component: ThreadRowBase,
  decorators: [
    (Story) => (
      <div className="w-56">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "aHzOp", groupId: "PUf7t", statesId: "N0dG2o" } },
  title: "Left Rail/Thread Row/Base",
} satisfies Meta<typeof ThreadRowBase>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Refreshing: Story = { args: { refreshing: true } };
