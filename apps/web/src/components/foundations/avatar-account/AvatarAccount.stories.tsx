import type { Meta, StoryObj } from "@storybook/react-vite";

import { AvatarAccount } from "./AvatarAccount";

const meta = {
  component: AvatarAccount,
  parameters: { pencil: { componentId: "VDbOo", groupId: "fVh0u" } },
  title: "Foundations/Avatar/Account",
} satisfies Meta<typeof AvatarAccount>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
