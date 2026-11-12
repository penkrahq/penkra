import { IconFileDiff } from "@tabler/icons-react";
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { PanelTabShared } from "./PanelTabShared";

const meta = {
  component: PanelTabShared,
  parameters: { pencil: { componentId: "nyAGp", groupId: "DH1W8", statesId: "FZRZ9" } },
  title: "Right Panel/Panel Tab/Shared",
} satisfies Meta<typeof PanelTabShared>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Files: Story = {};
export const ReviewSelected: Story = {
  args: { active: true, children: "Review", icon: <IconFileDiff />, onClose: () => {} },
};

function ClosingRow() {
  const [tabs, setTabs] = useState(["One", "Two", "Three", "Four"]);
  return (
    <div className="flex gap-1">
      {tabs.map((name) => (
        <PanelTabShared key={name} onClose={() => setTabs((all) => all.filter((t) => t !== name))}>
          {name}
        </PanelTabShared>
      ))}
    </div>
  );
}

/** P21: close tabs without moving the pointer; the tab that slides under it shows its X. */
export const CloseInPlace: Story = {
  parameters: { layout: "padded" },
  render: () => <ClosingRow />,
};
