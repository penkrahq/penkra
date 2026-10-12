// FILE: MessagesTimeline.toolDetails.browser.tsx
// Purpose: Browser regressions for inline tool-call detail expand/collapse motion.
// Layer: Vitest browser tests

import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadResourceOpenerContext } from "../../lib/threadResourceOpener";
import { MessagesTimeline } from "./MessagesTimeline";
import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";

function ToolDetailsTimeline() {
  return (
    <MessagesTimeline
      hasMessages
      isWorking={false}
      activeTurnInProgress={false}
      activeTurnStartedAt={null}
      timelineEntries={[
        {
          id: "entry-command-details",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-command-details",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            toolTitle: "Searched",
            command: `rg -n "toolDetails" apps/web/src`,
            toolDetails: {
              kind: "command",
              title: "Searched",
              command: `rg -n "toolDetails" apps/web/src`,
              output: {
                stdout: "apps/web/src/session-logic.ts:55: toolDetails",
              },
            },
          },
        },
      ]}
      nowIso="2026-03-17T19:12:30.000Z"
      expandedWorkGroups={{}}
      onToggleWorkGroup={() => {}}
      onImageExpand={() => {}}
      markdownCwd={undefined}
      resolvedTheme="dark"
      timestampFormat="locale"
      workspaceRoot={undefined}
    />
  );
}

function LiveActivityTimeline() {
  const nowMs = Date.now();
  return (
    <TimelineWorkEntryRow
      workEntry={{
        id: "work-live-activity",
        createdAt: "2026-03-17T19:12:28.000Z",
        label: "Bash",
        tone: "tool",
        itemType: "command_execution",
        toolTitle: "Running command",
        command: "bun install",
        liveActivity: {
          state: "running_tool",
          label: "Running bun install",
          startedAt: new Date(nowMs - 134_000).toISOString(),
          lastActivityAt: new Date(nowMs - 2_000).toISOString(),
          detail: "Resolving packages",
          progress: 0.42,
          elapsedSeconds: 132,
        },
      }}
      chatMetaFontSizePx={12}
      textFontSizePx={13}
      density="compact"
      onImageExpand={() => {}}
      markdownCwd={undefined}
      timestampFormat="24-hour"
    />
  );
}

function createTimelineHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:600px;height:520px;overflow:hidden;";
  document.body.append(host);
  return host;
}

async function settleLayout(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

describe("MessagesTimeline tool details", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("opens and closes command details with the shared disclosure motion", async () => {
    const host = createTimelineHost();
    const screen = await render(<ToolDetailsTimeline />, { container: host });
    try {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-tool-detail-trigger="true"]',
      )!;
      const region = document.querySelector<HTMLElement>('[data-slot="disclosure-region"]')!;
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("[data-tool-details-inline='true']")).toBeNull();
      trigger.click();
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      const details = document.querySelector<HTMLElement>('[data-tool-details-inline="true"]')!;
      expect(details).not.toBeNull();
      expect(region).not.toHaveAttribute("aria-hidden");
      expect(region).not.toHaveAttribute("inert");
      await expect
        .element(screen.getByText("apps/web/src/session-logic.ts:55: toolDetails"))
        .toBeVisible();
      trigger.click();
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
      expect(region).toHaveAttribute("inert");
      expect(details.isConnected).toBe(true);
      details.dispatchEvent(
        new TransitionEvent("transitionend", { bubbles: true, propertyName: "height" }),
      );
      expect(details.isConnected).toBe(true);
      region.dispatchEvent(
        new TransitionEvent("transitionend", { bubbles: true, propertyName: "opacity" }),
      );
      expect(details.isConnected).toBe(true);
      region.dispatchEvent(
        new TransitionEvent("transitionend", { bubbles: true, propertyName: "height" }),
      );
      await expect.poll(() => details.isConnected).toBe(false);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("releases closing details immediately when reduced motion removes the transition", async () => {
    const nativeMatchMedia = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) =>
      query === "(prefers-reduced-motion: reduce)"
        ? { ...nativeMatchMedia(query), matches: true }
        : nativeMatchMedia(query),
    );
    const host = createTimelineHost();
    const screen = await render(<ToolDetailsTimeline />, { container: host });
    try {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-tool-detail-trigger="true"]',
      )!;
      const region = document.querySelector<HTMLElement>('[data-slot="disclosure-region"]')!;
      region.style.transitionProperty = "none";
      trigger.click();
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector("[data-tool-details-inline='true']")).not.toBeNull();
      trigger.click();
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("[data-tool-details-inline='true']")).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps the same details mounted when reopened during close", async () => {
    const host = createTimelineHost();
    const screen = await render(<ToolDetailsTimeline />, { container: host });
    try {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-tool-detail-trigger="true"]',
      )!;
      const region = document.querySelector<HTMLElement>('[data-slot="disclosure-region"]')!;
      trigger.click();
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      const details = document.querySelector<HTMLElement>('[data-tool-details-inline="true"]')!;
      trigger.click();
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
      expect(details.isConnected).toBe(true);
      trigger.click();
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector("[data-tool-details-inline='true']")).toBe(details);
      expect(region).not.toHaveAttribute("inert");
      region.dispatchEvent(
        new TransitionEvent("transitionend", { bubbles: true, propertyName: "height" }),
      );
      expect(details.isConnected).toBe(true);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("the empty disclosure adds no row height or spacing before first open", async () => {
    const host = createTimelineHost();
    const screen = await render(<ToolDetailsTimeline />, { container: host });
    try {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-tool-detail-trigger="true"]',
      )!;
      const region = document.querySelector<HTMLElement>('[data-slot="disclosure-region"]')!;
      expect(region.getBoundingClientRect().height).toBe(0);
      expect(region.parentElement!.getBoundingClientRect().height).toBe(
        trigger.getBoundingClientRect().height,
      );
      expect(region).toHaveAttribute("inert");
      expect(document.querySelector("[data-tool-details-inline='true']")).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps live activity compact without adding a second details action", async () => {
    const host = createTimelineHost();
    const screen = await render(<LiveActivityTimeline />, { container: host });

    try {
      expect(document.body.textContent ?? "").toContain("Running command");
      expect(document.body.textContent ?? "").toContain("bun install");
      expect(document.body.textContent ?? "").not.toContain("Active");
      expect(document.body.textContent ?? "").not.toContain("2m 14s elapsed");
      expect(document.body.textContent ?? "").not.toContain("42%");
      expect(document.body.textContent ?? "").not.toContain("Resolving packages");
      const displayText = document.querySelector("[data-work-entry-display-text='true']");
      const activityMeta = document.querySelector("[data-live-activity-meta='true']");
      expect(displayText?.closest("p")).not.toBeNull();
      expect(activityMeta).toBeNull();
      expect(displayText?.closest("p")?.textContent ?? "").toContain("Running command");
      expect(displayText?.closest("p")?.textContent ?? "").toContain("bun install");

      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-tool-detail-trigger="true"]',
      );
      expect(trigger).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
      await settleLayout();
    }
  });

  it("keeps agent activity as the primary action when live metadata is present", async () => {
    const onOpenAgentActivity = vi.fn();
    const nowMs = Date.now();
    const host = createTimelineHost();
    const screen = await render(
      <TimelineWorkEntryRow
        workEntry={{
          id: "agent-live-activity",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "Agent task",
          tone: "tool",
          itemType: "collab_agent_tool_call",
          detail: "Review the implementation",
          liveActivity: {
            state: "running_tool",
            label: "Agent task",
            startedAt: new Date(nowMs - 2_000).toISOString(),
            lastActivityAt: new Date(nowMs - 1_000).toISOString(),
          },
        }}
        chatMetaFontSizePx={12}
        textFontSizePx={13}
        density="compact"
        onImageExpand={() => {}}
        markdownCwd={undefined}
        onOpenAgentActivity={onOpenAgentActivity}
        timestampFormat="locale"
      />,
      { container: host },
    );

    try {
      expect(document.querySelector("[data-tool-detail-trigger='true']")).toBeNull();
      document.querySelector<HTMLButtonElement>("button")?.click();
      expect(onOpenAgentActivity).toHaveBeenCalledWith("agent-live-activity");
      expect(document.querySelector("[data-tool-details-inline='true']")).toBeNull();
      expect(document.body.textContent ?? "").toContain("Agent task");
      expect(document.body.textContent ?? "").toContain("Review the implementation");
      expect(document.body.textContent ?? "").not.toContain("Active");
    } finally {
      await screen.unmount();
      host.remove();
      await settleLayout();
    }
  });

  it("opens activity-only changed files through the Thread resource handler", async () => {
    const openFile = vi.fn(() => true);
    const host = createTimelineHost();
    const screen = await render(
      <ThreadResourceOpenerContext.Provider
        value={{
          openFile,
          openUrl: () => false,
          showFileContextMenu: () => false,
          showUrlContextMenu: () => false,
        }}
      >
        <TimelineWorkEntryRow
          workEntry={{
            id: "file-live-activity",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Edited file",
            tone: "tool",
            itemType: "file_change",
            changedFiles: ["src/app.ts"],
            liveActivity: {
              state: "completed",
              label: "Edited file",
              lastActivityAt: "2026-03-17T19:12:29.000Z",
            },
          }}
          chatMetaFontSizePx={12}
          textFontSizePx={13}
          density="compact"
          onImageExpand={() => {}}
          markdownCwd={undefined}
          timestampFormat="locale"
        />
      </ThreadResourceOpenerContext.Provider>,
      { container: host },
    );

    try {
      const fileRow = document.querySelector<HTMLButtonElement>("[data-file-change-row='true']");
      expect(fileRow).not.toBeNull();
      fileRow?.click();
      expect(openFile).toHaveBeenCalledWith("src/app.ts");
      expect(document.querySelector("[data-tool-details-inline='true']")).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
      await settleLayout();
    }
  });

  it("preserves the file-open action for activity-only read rows", async () => {
    const openFile = vi.fn(() => true);
    const host = createTimelineHost();
    const screen = await render(
      <ThreadResourceOpenerContext.Provider
        value={{
          openFile,
          openUrl: () => false,
          showFileContextMenu: () => false,
          showUrlContextMenu: () => false,
        }}
      >
        <TimelineWorkEntryRow
          workEntry={{
            id: "read-live-activity",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Read file",
            tone: "tool",
            requestKind: "file-read",
            detail: "src/app.ts",
            liveActivity: {
              state: "completed",
              label: "Read file",
              lastActivityAt: "2026-03-17T19:12:29.000Z",
            },
          }}
          chatMetaFontSizePx={12}
          textFontSizePx={13}
          density="compact"
          onImageExpand={() => {}}
          markdownCwd={undefined}
          timestampFormat="locale"
        />
      </ThreadResourceOpenerContext.Provider>,
      { container: host },
    );

    try {
      expect(document.querySelector("[data-tool-detail-trigger='true']")).toBeNull();
      document.querySelector<HTMLButtonElement>("button")?.click();
      expect(openFile).toHaveBeenCalledWith("src/app.ts");
      expect(document.querySelector("[data-tool-details-inline='true']")).toBeNull();
      expect(document.body.textContent ?? "").toContain("Read file app.ts");
    } finally {
      await screen.unmount();
      host.remove();
      await settleLayout();
    }
  });
});
