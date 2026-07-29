import type { Meta, StoryObj } from "@storybook/react-vite";

import { AccountRowShared } from "./AccountRowShared";

const meta = {
  component: AccountRowShared,
  parameters: { pencil: { componentId: "QXbUg", groupId: "PUf7t", statesId: "N0dG2o" } },
  title: "Left Rail/Account Row/Shared",
} satisfies Meta<typeof AccountRowShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Selected: Story = { args: { selected: true } };
export const UpdateAvailable: Story = { args: { updateAvailable: true } };
export const Disabled: Story = { args: { disabled: true } };
