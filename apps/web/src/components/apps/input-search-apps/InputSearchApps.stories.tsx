import type { Meta, StoryObj } from "@storybook/react-vite";

import { InputSearchApps } from "./InputSearchApps";

const meta = {
  component: InputSearchApps,
  decorators: [
    (Story) => (
      <div className="w-[488px] max-w-[calc(100vw-3rem)]">
        <Story />
      </div>
    ),
  ],
  parameters: {
    pencil: {
      componentId: "Q9f3R9",
      groupId: "o1aLe",
    },
  },
  title: "Apps/Input Search Apps",
} satisfies Meta<typeof InputSearchApps>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
