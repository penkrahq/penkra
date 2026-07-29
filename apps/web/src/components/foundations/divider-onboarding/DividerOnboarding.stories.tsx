import type { Meta, StoryObj } from "@storybook/react-vite";

import { DividerOnboarding } from "./DividerOnboarding";

const meta = {
  component: DividerOnboarding,
  decorators: [(Story) => <div className="w-[488px]"><Story /></div>],
  parameters: { pencil: { componentId: "zvB0L", groupId: "fVh0u" } },
  title: "Foundations/Divider/Onboarding",
} satisfies Meta<typeof DividerOnboarding>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
