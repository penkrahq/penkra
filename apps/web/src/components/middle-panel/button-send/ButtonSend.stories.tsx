import type { Meta, StoryObj } from "@storybook/react-vite";

import { ButtonSend } from "./ButtonSend";

const meta = {
  component: ButtonSend,
  parameters: { pencil: { componentId: "eFqUm", groupId: "kVpYl" } },
  title: "Middle Panel/Button/Send",
} satisfies Meta<typeof ButtonSend>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Hover: Story = { args: { visualState: "hover" } };
export const Disabled: Story = { args: { visualState: "disabled" } };
export const Sending: Story = { args: { visualState: "sending" } };
export const Stop: Story = { args: { type: "button", visualState: "stop" } };
