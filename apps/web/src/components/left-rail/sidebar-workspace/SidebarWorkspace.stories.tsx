import type { Meta, StoryObj } from "@storybook/react-vite";

import { FolderGroupShared } from "../folder-group-shared/FolderGroupShared";
import { SpaceGroupShared } from "../space-group-shared/SpaceGroupShared";
import { SidebarWorkspace } from "./SidebarWorkspace";

const meta = {
  args: {
    children: (
      <SpaceGroupShared label="Personal">
        <FolderGroupShared
          defaultExpanded
          label="penut"
          showMore
          threads={[
            { id: "main", label: "Main", provider: "codex", state: "active" },
            { id: "metrics", label: "Analyze PostHog metrics", provider: "claudeAgent" },
            { id: "search", label: "Add user to Search Console", provider: "codex" },
            { id: "discord", label: "Set up Penut Discord", provider: "cursor" },
          ]}
        />
        <FolderGroupShared
          defaultExpanded
          label="Atferd"
          threads={[
            { id: "audit", label: "Audit HIPAA compliance", provider: "claudeAgent" },
            { id: "prune", label: "Prune database and local data", provider: "codex" },
          ]}
        />
      </SpaceGroupShared>
    ),
  },
  component: SidebarWorkspace,
  parameters: {
    layout: "fullscreen",
    pencil: { componentId: "UPCCE", groupId: "PUf7t" },
  },
  title: "Left Rail/Sidebar/Workspace",
} satisfies Meta<typeof SidebarWorkspace>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
