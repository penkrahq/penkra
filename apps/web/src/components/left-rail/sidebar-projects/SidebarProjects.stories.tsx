import type { Meta, StoryObj } from "@storybook/react-vite";

import { FolderGroupShared } from "../folder-group-shared/FolderGroupShared";
import { WorkspaceHeaderShared } from "../workspace-header-shared/WorkspaceHeaderShared";
import { SidebarProjects } from "./SidebarProjects";

const threads = Array.from({ length: 7 }, (_, index) => ({
  id: `thread-${index}`,
  label: `Project thread ${index + 1}`,
  provider: (index % 2 === 0 ? "claudeAgent" : "codex") as "claudeAgent" | "codex",
}));

const meta = {
  component: SidebarProjects,
  decorators: [
    (Story) => (
      <div className="h-80 w-60">
        <Story />
      </div>
    ),
  ],
  parameters: { pencil: { componentId: "mKbbW", groupId: "PUf7t" } },
  title: "Left Rail/Sidebar Projects/Vertical Scroll Region",
} satisfies Meta<typeof SidebarProjects>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Overflowing: Story = {
  args: {
    children: (
      <>
        <WorkspaceHeaderShared>penkra</WorkspaceHeaderShared>
        {["penut", "Borge", "Atferd"].map((label) => (
          <FolderGroupShared defaultExpanded key={label} label={label} showMore threads={threads} />
        ))}
      </>
    ),
  },
};
