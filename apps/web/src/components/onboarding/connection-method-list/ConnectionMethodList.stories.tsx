import type { Meta, StoryObj } from "@storybook/react-vite";

import { ConnectionMethodList } from "./ConnectionMethodList";

const meta = {
  component: ConnectionMethodList,
  parameters: { pencil: { componentId: "cv14N", groupId: "q9bzl" } },
  title: "Onboarding/Connection Method List",
} satisfies Meta<typeof ConnectionMethodList>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
