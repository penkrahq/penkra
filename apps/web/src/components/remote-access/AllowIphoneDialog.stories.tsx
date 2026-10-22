import type { Meta, StoryObj } from "@storybook/react-vite";

import { AllowIphoneDialog } from "./AllowIphoneDialog";

const meta = {
  component: AllowIphoneDialog,
  title: "Remote access/Allow iPhone",
  args: { onAnswer: () => {} },
} satisfies Meta<typeof AllowIphoneDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  args: { request: { requestId: "r1", phoneName: "Emmanuel's iPhone", code: "402229" } },
};
