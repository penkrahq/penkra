import type { Meta, StoryObj } from "@storybook/react-vite";

import { TrafficLightAffordance } from "./TrafficLightAffordance";

const meta = {
  component: TrafficLightAffordance,
  parameters: {
    pencil: { componentId: "s55hed", groupId: "fVh0u", responsiveStatesId: "ZKagZ" },
  },
  title: "Foundations/Traffic Light Affordance/macOS",
} satisfies Meta<typeof TrafficLightAffordance>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Windowed: Story = {};
export const Fullscreen: Story = { args: { fullscreen: true } };
