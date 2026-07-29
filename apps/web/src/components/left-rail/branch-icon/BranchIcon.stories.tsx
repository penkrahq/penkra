import type { Meta, StoryObj } from "@storybook/react-vite";

import { BranchIcon } from "./BranchIcon";

const meta = {
  component: BranchIcon,
  parameters: { pencil: { componentId: "S278Vl", groupId: "PUf7t" } },
  title: "Left Rail/Branch Icon",
} satisfies Meta<typeof BranchIcon>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
