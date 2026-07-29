import type { Meta, StoryObj } from "@storybook/react-vite";

import { ThreadRowShared } from "./ThreadRowShared";

const meta = {
  component: ThreadRowShared,
  decorators: [(Story) => <div className="w-56"><Story /></div>],
  parameters: {
    pencil: {
      componentId: "RR4w3",
      groupId: "PUf7t",
      harnessIconIds: [
        "UHPei",
        "R3VAsK",
        "Ympaa",
        "x7O54",
        "eKNhZ",
        "voEK6",
        "I15im",
        "fCOLZ",
        "mbMUu",
      ],
      selectedComponentId: "kapCo",
      statesId: "N0dG2o",
    },
  },
  title: "Left Rail/Thread Row/Shared",
} satisfies Meta<typeof ThreadRowShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Claude: Story = {};
export const Codex: Story = { args: { provider: "codex" } };
export const Cursor: Story = { args: { provider: "cursor" } };
export const Grok: Story = { args: { provider: "grok" } };
export const Droid: Story = { args: { provider: "droid" } };
export const Kilo: Story = { args: { provider: "kilo" } };
export const Pi: Story = { args: { provider: "pi" } };
export const OpenCode: Story = { args: { provider: "opencode" } };
export const Selected: Story = { args: { state: "selected" } };
export const Refreshing: Story = { args: { refreshing: true } };
export const Disabled: Story = { args: { disabled: true } };
