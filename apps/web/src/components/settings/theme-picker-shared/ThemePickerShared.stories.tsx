import type { Meta, StoryObj } from "@storybook/react-vite";

import { ThemePickerShared } from "./ThemePickerShared";

const meta = {
  component: ThemePickerShared,
  parameters: {
    pencil: {
      componentId: "H7QYVP",
      groupId: "L8Pc7b",
      menuId: "q9tPr",
      states: ["default", "hover", "active", "open", "disabled"],
    },
  },
  title: "Settings/Theme Picker/Shared",
} satisfies Meta<typeof ThemePickerShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Disabled: Story = { args: { disabled: true } };
