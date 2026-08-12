// FILE: whatsNew/entries.ts
// Purpose: Curated release notes rendered in the post-update dialog and Release history.

import type { WhatsNewEntry } from "./logic";

export const WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = [
  {
    version: "0.9.2",
    date: "Aug 8",
    features: [
      {
        id: "cross-platform-installers",
        title: "Install Penkra on macOS, Linux, and Windows",
        description:
          "The stable desktop release now includes native installers for macOS arm64, Linux x64, and Windows x64.",
        details:
          "macOS ships as a signed and notarized DMG with automatic updates, Linux ships as an AppImage with automatic updates, and Windows ships as an unsigned manual-download installer with checksums and build provenance. Windows may display an Unknown publisher or SmartScreen warning.",
      },
      {
        id: "steadier-sidebar-navigation",
        title: "Sidebar navigation stays aligned",
        description:
          "Thread selection and sidebar state now stay synchronized more reliably while moving through active work.",
      },
      {
        id: "faster-release-validation",
        title: "Desktop updates are built from stronger release gates",
        description:
          "Native packaging and startup checks now validate each advertised platform from the exact release source before publication.",
      },
    ],
  },
  {
    version: "0.9.1",
    date: "Aug 5",
    features: [
      {
        id: "durable-sidebar-arrangement",
        title: "Arrange your workspace directly",
        description:
          "Drag folders and tasks into the order and Space where they belong, and Penkra keeps that layout after a restart.",
        details:
          "Sidebar moves commit as one durable layout update, preserve pinned-item boundaries, carry nested task trees with their parent, and keep folder and loose-task ordering synchronized across reconnects and projection rebuilds.",
      },
      {
        id: "unified-task-layout-dragging",
        title: "Drag tasks into split views",
        description:
          "The same task drag can reorganize the sidebar or place a conversation beside another one.",
        details:
          "Penkra uses one typed drag system for sidebar sorting and chat-pane drop zones, with explicit eligibility checks so invalid or duplicate placements are rejected consistently.",
      },
      {
        id: "clear-agent-capability-boundaries",
        title: "Agent tools stay clear and predictable",
        description:
          "Penkra Apps, built-in host commands, and provider tools remain distinct so agents can discover and use the right capability.",
        details:
          "Provider plugins and user MCP servers retain their normal configuration, while Penkra's authenticated gateway exposes only registered Penkra and App operations.",
      },
    ],
  },
];
