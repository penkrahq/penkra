import type { Meta, StoryObj } from "@storybook/react-vite";

import { ThemePanelShared } from "./ThemePanelShared";

const meta = {
  component: ThemePanelShared,
  parameters: {
    pencil: {
      componentId: "xRiiX",
      groupId: "L8Pc7b",
      themePickerId: "H7QYVP",
    },
  },
  title: "Settings/Theme Panel/Shared",
} satisfies Meta<typeof ThemePanelShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
