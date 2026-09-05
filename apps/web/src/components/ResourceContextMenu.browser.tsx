import "../index.css";

import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  ThreadResourceOpenerContext,
  showThreadResourceContextMenu,
  type ThreadResourceOpener,
} from "../lib/threadResourceOpener";
import { InlineLinkChip } from "./InlineLinkChip";
import { InlineMentionChip } from "./chat/InlineMentionChip";

function openerForTest(overrides: Partial<ThreadResourceOpener>): ThreadResourceOpener {
  return {
    openFile: () => false,
    openUrl: () => false,
    showFileContextMenu: () => false,
    showUrlContextMenu: () => false,
    ...overrides,
  };
}

function ResourceMenuSurface(props: { children: ReactNode; opener: ThreadResourceOpener }) {
  return (
    <ThreadResourceOpenerContext.Provider value={props.opener}>
      <div
        onContextMenuCapture={(event) => {
          if (
            showThreadResourceContextMenu({
              opener: props.opener,
              target: event.target,
              position: { x: event.clientX, y: event.clientY },
            })
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
      >
        {props.children}
      </div>
    </ThreadResourceOpenerContext.Provider>
  );
}

describe("Thread resource context menus", () => {
  it("routes a link chip's context menu through its URL resource", async () => {
    const showUrlContextMenu = vi.fn(() => true);
    const opener = openerForTest({ showUrlContextMenu });
    const screen = await render(
      <ResourceMenuSurface opener={opener}>
        <InlineLinkChip url="https://example.com/report" interactive />
      </ResourceMenuSurface>,
    );

    try {
      const chip = document.querySelector("button");
      expect(chip).not.toBeNull();
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 24,
        clientY: 48,
      });
      chip!.dispatchEvent(event);
      await vi.waitFor(() =>
        expect(showUrlContextMenu).toHaveBeenCalledWith("https://example.com/report", {
          x: 24,
          y: 48,
        }),
      );
      expect(event.defaultPrevented).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("routes a file chip's context menu through its local resource", async () => {
    const showFileContextMenu = vi.fn(() => true);
    const opener = openerForTest({ showFileContextMenu });
    const screen = await render(
      <ResourceMenuSurface opener={opener}>
        <InlineMentionChip
          path="/workspace/report.pdf"
          resourcePath="/workspace/report.pdf"
          href="/workspace/report.pdf"
          theme="light"
        />
      </ResourceMenuSurface>,
    );

    try {
      const chip = document.querySelector("a");
      expect(chip).not.toBeNull();
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 30,
        clientY: 60,
      });
      chip!.dispatchEvent(event);
      await vi.waitFor(() =>
        expect(showFileContextMenu).toHaveBeenCalledWith("/workspace/report.pdf", {
          x: 30,
          y: 60,
        }),
      );
      expect(event.defaultPrevented).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("recognizes ordinary HTTP anchors without component-specific wiring", async () => {
    const showUrlContextMenu = vi.fn(() => true);
    const opener = openerForTest({ showUrlContextMenu });
    const screen = await render(
      <ResourceMenuSurface opener={opener}>
        <a href="https://example.com/download">Download</a>
      </ResourceMenuSurface>,
    );

    try {
      const anchor = document.querySelector("a");
      expect(anchor).not.toBeNull();
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 18,
        clientY: 36,
      });
      anchor!.dispatchEvent(event);
      await vi.waitFor(() =>
        expect(showUrlContextMenu).toHaveBeenCalledWith("https://example.com/download", {
          x: 18,
          y: 36,
        }),
      );
      expect(event.defaultPrevented).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("leaves internal and relative anchors to their existing context menu", async () => {
    const showUrlContextMenu = vi.fn(() => true);
    const opener = openerForTest({ showUrlContextMenu });
    const screen = await render(
      <ResourceMenuSurface opener={opener}>
        <a href="#details">Details</a>
        <a href="settings">Settings</a>
      </ResourceMenuSurface>,
    );

    try {
      for (const anchor of document.querySelectorAll("a")) {
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        anchor.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(showUrlContextMenu).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
