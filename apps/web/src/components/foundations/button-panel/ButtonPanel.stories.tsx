import type { Meta, StoryObj } from "@storybook/react-vite";

import { ButtonPanel } from "./ButtonPanel";

const meta = {
  component: ButtonPanel,
  parameters: { pencil: { componentId: "TnpKi", groupId: "fVh0u" } },
  title: "Foundations/Button/Panel",
} satisfies Meta<typeof ButtonPanel>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
