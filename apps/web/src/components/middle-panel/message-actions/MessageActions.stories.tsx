import type { Meta, StoryObj } from "@storybook/react-vite";

import { MessageActions } from "./MessageActions";

const meta = {
  component: MessageActions,
  parameters: { pencil: { componentId: "Bx6FM", groupId: "e46ib4", relatedId: "vI265" } },
  title: "Middle Panel/Message Actions",
} satisfies Meta<typeof MessageActions>;

export default meta;
type Story = StoryObj<typeof meta>;
export const User: Story = { args: { visible: true } };
export const Assistant: Story = { args: { assistant: true, visible: true } };
