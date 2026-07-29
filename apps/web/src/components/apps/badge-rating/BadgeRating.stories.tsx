import type { Meta, StoryObj } from "@storybook/react-vite";

import { BadgeRating } from "./BadgeRating";

const meta = {
  component: BadgeRating,
  parameters: { pencil: { componentId: "gqhMw", groupId: "o1aLe" } },
  title: "Apps/Badge/Rating",
} satisfies Meta<typeof BadgeRating>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
