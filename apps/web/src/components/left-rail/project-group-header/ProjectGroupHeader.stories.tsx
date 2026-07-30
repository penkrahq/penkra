import type { Meta, StoryObj } from "@storybook/react-vite";

import { ProjectGroupHeader } from "./ProjectGroupHeader";

const meta = {
  component: ProjectGroupHeader,
  decorators: [
    (Story) => (
      <div className="w-56">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "KYAyf", groupId: "PUf7t", statesId: "N0dG2o" } },
  title: "Left Rail/Project Group Header",
} satisfies Meta<typeof ProjectGroupHeader>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Open: Story = {};
export const Closed: Story = { args: { expanded: false } };
export const Disabled: Story = { args: { disabled: true } };
