import type { Meta, StoryObj } from "@storybook/react-vite";

import { FolderGroupShared } from "../folder-group-shared/FolderGroupShared";
import { WorkspaceHeaderShared } from "../workspace-header-shared/WorkspaceHeaderShared";
import { SidebarWorkspace } from "./SidebarWorkspace";

const meta = {
  args: {
    activeNavigationItemId: "new-chat",
    children: (
      <>
        <WorkspaceHeaderShared>penkra</WorkspaceHeaderShared>
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
      </>
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
