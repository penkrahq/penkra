import type { Meta, StoryObj } from "@storybook/react-vite";

import { ButtonSignInWithClaude } from "./ButtonSignInWithClaude";

const meta = {
  component: ButtonSignInWithClaude,
  decorators: [(Story) => <div className="w-[488px]"><Story /></div>],
  parameters: { pencil: { componentId: "TO6VK", groupId: "fVh0u" } },
  title: "Foundations/Button/Sign in with Claude",
} satisfies Meta<typeof ButtonSignInWithClaude>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
