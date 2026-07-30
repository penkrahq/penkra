import { IconSettings } from "@tabler/icons-react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { SettingsNavRowShared } from "./SettingsNavRowShared";

const meta = {
  args: { children: "General", icon: <IconSettings /> },
  component: SettingsNavRowShared,
  decorators: [
    (Story) => (
      <div className="w-[196px]">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "H9SGJk", groupId: "L8Pc7b", statesId: "Ns7XV" } },
  title: "Settings/Settings Nav Row/Shared",
} satisfies Meta<typeof SettingsNavRowShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Selected: Story = { args: { selected: true } };
