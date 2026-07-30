import type { Meta, StoryObj } from "@storybook/react-vite";

import { BannerFeaturedApp } from "./BannerFeaturedApp";

const meta = {
  component: BannerFeaturedApp,
  decorators: [
    (Story) => (
      <div className="w-[696px] max-w-[calc(100vw-3rem)]">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "NCeS7", groupId: "o1aLe" } },
  title: "Apps/Banner/Featured App",
} satisfies Meta<typeof BannerFeaturedApp>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
