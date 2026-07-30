import type { Meta, StoryObj } from "@storybook/react-vite";

import { MessageUser } from "./MessageUser";

const meta = {
  args: {
    children:
      "Who gets the Patient onboarding completed mail on prod? Is it a list or just one person?",
  },
  component: MessageUser,
  decorators: [
    (Story) => (
      <div className="w-[560px]">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "BDWPr", groupId: "e46ib4" } },
  title: "Middle Panel/Message/User",
} satisfies Meta<typeof MessageUser>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
