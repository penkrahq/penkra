import type { Meta, StoryObj } from "@storybook/react-vite";

import { DisclosureRowShared } from "./DisclosureRowShared";

const meta = {
  component: DisclosureRowShared,
  decorators: [(Story) => <div className="w-56"><Story /></div>],
  parameters: { pencil: { componentId: "opCnp", groupId: "PUf7t", statesId: "N0dG2o" } },
  title: "Left Rail/Disclosure Row/Shared",
} satisfies Meta<typeof DisclosureRowShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Closed: Story = {};
export const Open: Story = { args: { expanded: true, showTrailing: true } };
