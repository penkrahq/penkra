import type { Meta, StoryObj } from "@storybook/react-vite";

import { RowInstalledApp } from "./RowInstalledApp";

const meta = {
  component: RowInstalledApp,
  decorators: [(Story) => <div className="w-[696px] max-w-[calc(100vw-3rem)]"><Story /></div>],
  parameters: { pencil: { componentId: "aPvtw", groupId: "o1aLe" } },
  title: "Apps/Row/Installed App",
} satisfies Meta<typeof RowInstalledApp>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
