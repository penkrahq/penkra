import type { Meta, StoryObj } from "@storybook/react-vite";

import { MenuThemePicker } from "./MenuThemePicker";

const meta = {
  component: MenuThemePicker,
  parameters: { pencil: { componentId: "q9tPr", groupId: "L8Pc7b" } },
  title: "Settings/Menu/Theme Picker",
} satisfies Meta<typeof MenuThemePicker>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
