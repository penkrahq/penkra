import "../../index.css";

import type { CleanCoreThreadItem } from "@penkra/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadItemRow } from "./ThreadItemRow";

const item = (
  kind: CleanCoreThreadItem["kind"],
  overrides: Partial<CleanCoreThreadItem> = {},
): CleanCoreThreadItem => ({
  threadId: "thread-1" as CleanCoreThreadItem["threadId"],
  seq: 3,
  sourceId: "s-3",
  turnId: null,
  kind,
  status: "done",
  text: "hello",
  data: null,
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
  ...overrides,
});

const renderItem = (value: CleanCoreThreadItem) =>
  render(<ThreadItemRow item={value} markdownCwd={undefined} onImageExpand={vi.fn()} />);

describe("ThreadItemRow", () => {
  it("renders a user item with its file attachment", async () => {
    const screen = await renderItem(
      item("user", {
        text: "please build the thing",
        data: JSON.stringify({
          attachments: [
            { type: "file", id: "f1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 12 },
          ],
        }),
      }),
    );
    try {
      expect(document.querySelector('[data-thread-item-kind="user"]')).not.toBeNull();
      await expect.element(page.getByText("please build the thing")).toBeVisible();
      await expect.element(page.getByText("notes.txt")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("renders assistant text through ChatMarkdown", async () => {
    const screen = await renderItem(
      item("text", { text: "Hello from the assistant", sourceId: "m-1" }),
    );
    try {
      expect(document.querySelector('[data-thread-item-kind="text"]')).not.toBeNull();
      await expect.element(page.getByText("Hello from the assistant")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("renders reasoning behind a disclosure", async () => {
    const screen = await renderItem(
      item("reasoning", { text: "because reasons", sourceId: "r-1" }),
    );
    try {
      expect(document.querySelector('[data-thread-item-kind="reasoning"]')).not.toBeNull();
      await page.getByRole("button", { name: /Reasoning/ }).click();
      await expect.element(page.getByText("because reasons")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("renders a tool item through TimelineWorkEntryRow", async () => {
    const screen = await renderItem(
      item("tool", {
        sourceId: "call-1",
        text: "Bash",
        data: JSON.stringify({
          tone: "tool",
          kind: "tool.completed",
          summary: "Bash",
          payload: {
            title: "Bash",
            status: "completed",
            data: { toolCallId: "call-1", toolName: "Bash", command: "ls" },
          },
        }),
      }),
    );
    try {
      expect(document.querySelector('[data-thread-item-kind="tool"]')).not.toBeNull();
      await expect.element(page.getByText("Bash").first()).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("renders a notice item through TimelineWorkEntryRow", async () => {
    const screen = await renderItem(
      item("notice", {
        sourceId: "notice-1",
        text: "be careful",
        data: JSON.stringify({
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: { message: "be careful", detail: "be careful" },
        }),
      }),
    );
    try {
      expect(document.querySelector('[data-thread-item-kind="notice"]')).not.toBeNull();
      await expect.element(page.getByText("be careful").first()).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("renders an open question through ComposerPendingUserInputPanel", async () => {
    const screen = await renderItem(
      item("question", {
        sourceId: "req-1",
        status: "open",
        text: "Which database?",
        data: JSON.stringify({
          questions: [
            {
              id: "q1",
              header: "Database",
              question: "Which database?",
              options: [{ label: "SQLite" }, { label: "Postgres" }],
            },
          ],
        }),
      }),
    );
    try {
      expect(document.querySelector('[data-thread-item-kind="question"]')).not.toBeNull();
      await expect.element(page.getByText("Which database?")).toBeVisible();
      await expect.element(page.getByText("SQLite")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
