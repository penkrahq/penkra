// FILE: MessagesTimeline.toolGroupCollapse.browser.tsx
// Purpose: Browser regressions for collapsing settled tool-call runs into
//          summary rows ("Ran 4 commands") once a newer narration block starts.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId } from "@penkra/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import type { TimelineEntry } from "../../session-logic";

function assistantEntry(
  id: string,
  text: string,
  streaming: boolean,
  completedAt?: string,
): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: "2026-03-17T19:12:28.000Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role: "assistant",
      text,
      createdAt: "2026-03-17T19:12:28.000Z",
      ...(completedAt ? { completedAt } : {}),
      streaming,
    },
  };
}

function commandEntry(id: string, command: string): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "work",
    createdAt: "2026-03-17T19:12:28.000Z",
    entry: {
      id,
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "Ran command",
      tone: "tool",
      itemType: "command_execution",
      toolStatus: "completed",
      command,
    },
  };
}

function thinkingEntry(id: string, label: string): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "work",
    createdAt: "2026-03-17T19:12:28.000Z",
    entry: {
      id,
      createdAt: "2026-03-17T19:12:28.000Z",
      label,
      tone: "thinking",
    },
  };
}

const SETTLED_COMMANDS = [
  "bun run lint",
  "bun run typecheck",
  "bun run build",
  "node scripts/check.mjs",
];
// Commands whose display text passes through verbatim (no humanized rewrite).
const LIVE_COMMANDS = ["git status", "node scripts/tail.mjs"];

function ToolGroupCollapseTimeline(props: { timelineEntries: TimelineEntry[] }) {
  return (
    <MessagesTimeline
      hasMessages
      isWorking={false}
      activeTurnInProgress
      activeTurnStartedAt="2026-03-17T19:12:20.000Z"
      timelineEntries={props.timelineEntries}
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

function createTimelineHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:600px;height:520px;overflow:hidden;";
  document.body.append(host);
  return host;
}

function findSummaryTrigger(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) =>
      (button.textContent ?? "").includes(label),
    ) ?? null
  );
}

function isVisibleOutsideClosedDisclosure(text: string): boolean {
  // The innermost element containing the text (command labels may span nested
  // spans, so a leaf-only check would miss them).
  const match = [...document.querySelectorAll<HTMLElement>("*")].findLast((element) =>
    (element.textContent ?? "").includes(text),
  );
  return match !== undefined && match.closest("[aria-hidden='true']") === null;
}

describe("MessagesTimeline tool group collapse", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("collapses the settled run behind a summary and keeps the live run expanded", async () => {
    const host = createTimelineHost();
    const screen = await render(
      <ToolGroupCollapseTimeline
        timelineEntries={[
          assistantEntry("narration-1", "Looking at the failing checks first.", false),
          ...SETTLED_COMMANDS.map((command, index) => commandEntry(`settled-${index}`, command)),
          assistantEntry("narration-2", "Now inspecting the working tree.", true),
          ...LIVE_COMMANDS.map((command, index) => commandEntry(`live-${index}`, command)),
        ]}
      />,
      { container: host },
    );

    try {
      await expect.poll(() => findSummaryTrigger("Ran 4 commands") !== null).toBe(true);
      const trigger = findSummaryTrigger("Ran 4 commands")!;
      expect(trigger.getAttribute("aria-expanded")).toBe("false");

      // Closed groups do not mount every tool row; this keeps large settled
      // transcripts cheap until the user asks to inspect the details.
      for (const command of SETTLED_COMMANDS) {
        expect(document.body.textContent ?? "").not.toContain(command);
      }

      // The live (newest) run renders individual rows with no summary trigger.
      expect(findSummaryTrigger("Ran 2 commands")).toBeNull();
      for (const command of LIVE_COMMANDS) {
        expect(isVisibleOutsideClosedDisclosure(command)).toBe(true);
      }

      trigger.click();

      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      for (const command of SETTLED_COMMANDS) {
        await expect.poll(() => isVisibleOutsideClosedDisclosure(command)).toBe(true);
      }

      trigger.click();

      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("false");
      // Rows remain mounted and inert until the shared disclosure reports that
      // its height transition completed, then the retained content is released.
      const closingRegion = trigger.parentElement?.querySelector<HTMLElement>(
        "[data-slot='disclosure-region']",
      );
      expect(closingRegion).not.toBeNull();
      expect(closingRegion!.getAttribute("aria-hidden")).toBe("true");
      expect(document.body.textContent ?? "").toContain(SETTLED_COMMANDS[0]!);
      closingRegion!.dispatchEvent(
        new TransitionEvent("transitionend", { bubbles: true, propertyName: "height" }),
      );
      await expect
        .poll(() => (document.body.textContent ?? "").includes(SETTLED_COMMANDS[0]!))
        .toBe(false);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("places Worked for above an image presented inside a settled assistant turn", async () => {
    const host = createTimelineHost();
    const screen = await render(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-media-user",
            kind: "message",
            createdAt: "2026-03-17T19:12:27.000Z",
            message: {
              id: MessageId.makeUnsafe("media-user"),
              role: "user",
              text: "Make an image",
              createdAt: "2026-03-17T19:12:27.000Z",
              streaming: false,
            },
          },
          assistantEntry(
            "media-preamble",
            "Preparing the image.",
            false,
            "2026-03-17T19:12:28.500Z",
          ),
          {
            id: "entry-presented-media",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "presented-media",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Showed concept.png",
              tone: "info",
              activityKind: "media.presented",
              presentedMedia: {
                attachmentId: "att_v2_media-browser-test",
                name: "concept.png",
                mimeType: "image/png",
                sizeBytes: 200,
                type: "image",
              },
            },
          },
          commandEntry("image-generation", "generate-image"),
          assistantEntry("media-final", "Here it is.", false, "2026-03-17T19:12:30.500Z"),
        ]}
        nowIso="2026-03-17T19:12:31.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
      { container: host },
    );

    try {
      const summary = document.querySelector<HTMLElement>(
        '[data-timeline-row-kind="message"]:has(button[aria-expanded])',
      );
      const media = document.querySelector<HTMLElement>(
        '[data-presented-media-id="att_v2_media-browser-test"]',
      );
      const finalAnswer = document.querySelector<HTMLElement>(
        '[data-assistant-message-id="media-final"]',
      );
      expect(summary?.textContent).toContain("Worked for");
      expect(media).not.toBeNull();
      expect(finalAnswer).not.toBeNull();
      expect(summary!.getBoundingClientRect().top).toBeLessThan(media!.getBoundingClientRect().top);
      expect(media!.getBoundingClientRect().top).toBeLessThan(
        finalAnswer!.getBoundingClientRect().top,
      );
      expect(document.body.textContent).not.toContain("Preparing the image.");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders Worked for above media without an empty final assistant row", async () => {
    const host = createTimelineHost();
    const screen = await render(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-media-first-user",
            kind: "message",
            createdAt: "2026-03-17T19:12:27.000Z",
            message: {
              id: MessageId.makeUnsafe("media-first-user"),
              role: "user",
              text: "Make an image",
              createdAt: "2026-03-17T19:12:27.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-media-first-output",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "media-first-output",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Showed concept.png",
              tone: "info",
              activityKind: "media.presented",
              presentedMedia: {
                attachmentId: "att_v2_media-first-browser-test",
                name: "concept.png",
                mimeType: "image/png",
                sizeBytes: 200,
                type: "image",
              },
            },
          },
          commandEntry("media-first-work", "generate-image"),
          assistantEntry("media-first-final", "", false, "2026-03-17T19:12:30.500Z"),
        ]}
        nowIso="2026-03-17T19:12:31.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
      { container: host },
    );

    try {
      const mediaRow = document.querySelector<HTMLElement>('[data-timeline-row-kind="media"]');
      const summary = mediaRow?.querySelector<HTMLElement>("button[aria-expanded]");
      const image = mediaRow?.querySelector<HTMLElement>(
        '[data-presented-media-id="att_v2_media-first-browser-test"]',
      );
      const finalAnswer = document.querySelector<HTMLElement>(
        '[data-assistant-message-id="media-first-final"]',
      );
      expect(summary?.textContent).toContain("Worked for");
      expect(image).not.toBeNull();
      expect(finalAnswer).toBeNull();
      expect(document.body.textContent).not.toContain("(empty response)");
      expect(summary!.getBoundingClientRect().top).toBeLessThan(image!.getBoundingClientRect().top);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("collapses mid-turn as soon as a thinking block splits the live group", async () => {
    const host = createTimelineHost();
    // One live inline group: settled commands, then a thinking boundary, then
    // the live tail. The run before the boundary must collapse while the turn
    // is still in progress — not only once it finishes.
    const screen = await render(
      <ToolGroupCollapseTimeline
        timelineEntries={[
          assistantEntry("narration-1", "Looking at the failing checks first.", true),
          ...SETTLED_COMMANDS.map((command, index) => commandEntry(`settled-${index}`, command)),
          thinkingEntry("think-1", "Weighing the next verification step"),
          ...LIVE_COMMANDS.map((command, index) => commandEntry(`live-${index}`, command)),
        ]}
      />,
      { container: host },
    );

    try {
      await expect.poll(() => findSummaryTrigger("Ran 4 commands") !== null).toBe(true);
      expect(findSummaryTrigger("Ran 4 commands")!.getAttribute("aria-expanded")).toBe("false");
      for (const command of SETTLED_COMMANDS) {
        expect(document.body.textContent ?? "").not.toContain(command);
      }

      // The run after the thinking boundary is the live tail: expanded rows,
      // no summary trigger.
      expect(findSummaryTrigger("Ran 2 commands")).toBeNull();
      for (const command of LIVE_COMMANDS) {
        expect(isVisibleOutsideClosedDisclosure(command)).toBe(true);
      }
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
