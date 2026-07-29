import type { Meta, StoryObj } from "@storybook/react-vite";

import { SettingRowShared } from "../setting-row-shared/SettingRowShared";
import { SettingsSectionShared } from "./SettingsSectionShared";

const meta = {
  component: SettingsSectionShared,
  parameters: { pencil: { componentId: "jDh8n", groupId: "L8Pc7b" } },
  title: "Settings/Settings Section/Shared",
} satisfies Meta<typeof SettingsSectionShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  args: {
    children: (
      <>
        <SettingRowShared />
        <SettingRowShared label="Play sounds" />
        <SettingRowShared label="Show previews" />
      </>
    ),
  },
};
