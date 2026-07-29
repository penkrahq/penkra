import type { Meta, StoryObj } from "@storybook/react-vite";

import { ThemePreviewCardShared } from "./ThemePreviewCardShared";

const meta = {
  component: ThemePreviewCardShared,
  parameters: { pencil: { componentId: "YjdYo", groupId: "L8Pc7b" } },
  title: "Settings/Theme Preview Card/Shared",
} satisfies Meta<typeof ThemePreviewCardShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Light: Story = {};
export const Dark: Story = { args: { label: "Dark", mode: "dark" } };
export const Selected: Story = { args: { selected: true } };
