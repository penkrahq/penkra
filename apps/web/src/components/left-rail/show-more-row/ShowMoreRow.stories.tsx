import type { Meta, StoryObj } from "@storybook/react-vite";

import { ShowMoreRow } from "./ShowMoreRow";

const meta = {
  component: ShowMoreRow,
  decorators: [
    (Story) => (
      <div className="w-56">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "AnPRU", groupId: "PUf7t", statesId: "N0dG2o" } },
  title: "Left Rail/Show More Row",
} satisfies Meta<typeof ShowMoreRow>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };
