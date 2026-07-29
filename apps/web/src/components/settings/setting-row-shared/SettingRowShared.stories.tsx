import type { Meta, StoryObj } from "@storybook/react-vite";

import { SwitchShared } from "~/components/foundations/switch-shared/SwitchShared";
import { SettingRowShared } from "./SettingRowShared";

const meta = {
  args: {
    control: <SwitchShared aria-label="Allow notifications" />,
    description: "Show a notification when an agent finishes.",
  },
  component: SettingRowShared,
  decorators: [(Story) => <div className="w-[400px]"><Story /></div>],
  parameters: { pencil: { componentId: "x2ssr7", groupId: "L8Pc7b" } },
  title: "Settings/Setting Row/Shared",
} satisfies Meta<typeof SettingRowShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
