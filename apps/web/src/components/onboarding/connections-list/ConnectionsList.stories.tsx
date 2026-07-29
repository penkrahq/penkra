import type { Meta, StoryObj } from "@storybook/react-vite";

import { ConnectionsList } from "./ConnectionsList";

const meta = {
  component: ConnectionsList,
  parameters: { pencil: { componentId: "EU9Dz", groupId: "q9bzl" } },
  title: "Onboarding/Connections List",
} satisfies Meta<typeof ConnectionsList>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
