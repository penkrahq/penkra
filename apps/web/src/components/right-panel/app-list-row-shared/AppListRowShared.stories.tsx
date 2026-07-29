import type { Meta, StoryObj } from "@storybook/react-vite";

import { GitHubIcon } from "~/components/Icons";
import { AppListRowShared } from "./AppListRowShared";

const meta = {
  args: { children: "GitHub", icon: <GitHubIcon />, shortcut: "⌃⇧G" },
  component: AppListRowShared,
  decorators: [(Story) => <div className="w-[260px]"><Story /></div>],
  parameters: { pencil: { componentId: "jjaEQ", groupId: "DH1W8", statesId: "RUn4U" } },
  title: "Right Panel/App List Row/Shared",
} satisfies Meta<typeof AppListRowShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Selected: Story = { args: { selected: true } };
export const Disabled: Story = { args: { disabled: true } };
