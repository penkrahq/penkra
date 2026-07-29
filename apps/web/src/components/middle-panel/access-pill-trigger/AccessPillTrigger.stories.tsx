import type { Meta, StoryObj } from "@storybook/react-vite";

import { AccessPillTrigger } from "./AccessPillTrigger";

const meta = {
  component: AccessPillTrigger,
  parameters: { pencil: { componentId: "iP6oE", groupId: "e46ib4" } },
  title: "Middle Panel/Access Pill/Trigger",
} satisfies Meta<typeof AccessPillTrigger>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
