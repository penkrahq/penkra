import "../../../../index.css";
import {
  FolderId,
  SpaceId,
  ThreadId,
  type NativeApi,
  type CleanCoreArchivedChat,
} from "@penkra/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
const harness = vi.hoisted(() => ({
  navigation: vi.fn(),
  chats: vi.fn(),
  restore: vi.fn(),
  command: vi.fn(),
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () =>
    ({
      cleanCore: {
        listArchivedNavigation: harness.navigation,
        listArchivedThreads: harness.chats,
        restoreThread: harness.restore,
        updateNavigation: harness.command,
      },
    }) as unknown as NativeApi,
}));
import { toastManager } from "~/components/ui/toast";
import { useStore } from "~/store";
import { SettingsArchivePage } from "./SettingsArchivePage";
const timestamp = "2026-10-10T00:00:00.000Z";
const spaceId = SpaceId.make("archive-space");
const folderId = FolderId.make("archive-folder");
const icon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
const chat = (n: number): CleanCoreArchivedChat => ({
  id: ThreadId.make(`chat-${n}`),
  deletesInActiveDays: 30,
  folderId,
  spaceId,
  title: `Archived chat ${n}`,
  provider: "codex",
  folder: "Notes",
  space: "Work",
  archivedAt: timestamp,
  restoresFolder: true,
  restoresSpace: true,
});
describe("Settings Archive", () => {
  beforeEach(() => {
    useStore.setState({ spaces: [] });
    harness.navigation.mockResolvedValue({
      totalChats: 51,
      spaces: [{ id: spaceId, name: "Work", folders: 1, chats: 51, archivedAt: timestamp }],
      folders: [
        {
          id: folderId,
          name: "Notes",
          space: "Work",
          chats: 51,
          archivedAt: timestamp,
          iconDataUrl: icon,
        },
      ],
    });
    harness.chats
      .mockResolvedValueOnce({
        total: 51,
        threads: Array.from({ length: 50 }, (_, n) => chat(n)),
        nextCursor: { archivedAt: timestamp, id: ThreadId.make("chat-49") },
      })
      .mockResolvedValue({ total: 51, threads: [chat(50)], nextCursor: null });
    harness.restore.mockResolvedValue(undefined);
    harness.command.mockResolvedValue({ sequence: 1 });
  });
  afterEach(() => {
    vi.resetAllMocks();
    document.body.innerHTML = "";
  });
  it("renders Spaces, Folders and Chats with their icons and loads the next page", async () => {
    await render(<SettingsArchivePage />);
    await expect.element(page.getByRole("button", { name: "Show 1 more" })).toBeVisible();
    expect(Array.from(document.querySelectorAll("h2"), (e) => e.textContent)).toEqual([
      "Spaces1",
      "Folders1",
      "Chats51",
    ]);
    expect(document.querySelector('[data-slot="folder-state-icon"] img')?.getAttribute("src")).toBe(
      icon,
    );
    const chatRow = page.getByText("Archived chat 0", { exact: true }).element()
      .parentElement?.parentElement;
    expect(chatRow?.querySelector("svg")).not.toBeNull();
    expect(chatRow?.textContent).toContain("deletes in 30 active days");
    await page.getByRole("button", { name: "Show 1 more" }).click();
    await expect.element(page.getByText("Archived chat 50", { exact: true })).toBeVisible();
    expect(harness.chats.mock.calls).toEqual([
      [{ cursor: null }],
      [{ cursor: { archivedAt: timestamp, id: "chat-49" } }],
    ]);
    expect(harness.navigation).toHaveBeenCalledTimes(1);
    await expect
      .element(page.getByRole("button", { name: /Show .* more/ }))
      .not.toBeInTheDocument();
  });
  it("restores a chat with its ancestors while retaining sibling chats", async () => {
    await render(<SettingsArchivePage />);
    await expect.element(page.getByText("Archived chat 0", { exact: true })).toBeVisible();
    const chatRow = page.getByText("Archived chat 0", { exact: true }).element()
      .parentElement?.parentElement;
    (chatRow?.querySelector("button") as HTMLButtonElement).click();
    await expect
      .element(page.getByText("Archived chat 0", { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("Archived chat 1", { exact: true })).toBeVisible();
    expect(harness.command.mock.calls.map(([command]) => command.update.action)).toEqual([
      "space.restore",
      "folder.update",
    ]);
    expect(harness.command.mock.invocationCallOrder[1]).toBeLessThan(
      harness.restore.mock.invocationCallOrder[0]!,
    );
    expect(harness.restore).toHaveBeenCalledWith({
      threadId: "chat-0",
      updatedAt: expect.any(String),
    });
    await expect.element(page.getByText("No archived Spaces")).toBeVisible();
    await expect.element(page.getByText("No archived Folders")).toBeVisible();
  });
  it("stops after a Space restore failure, shows the error and re-reads the lists", async () => {
    const toast = vi.spyOn(toastManager, "add");
    harness.command.mockRejectedValueOnce(new Error("A Space named Work already exists."));
    await render(<SettingsArchivePage />);
    await expect.element(page.getByText("Archived chat 0", { exact: true })).toBeVisible();
    const row = page.getByText("Archived chat 0", { exact: true }).element()
      .parentElement?.parentElement;
    (row?.querySelector("button") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(harness.navigation).toHaveBeenCalledTimes(2));
    expect(harness.command.mock.calls.map(([command]) => command.update.action)).toEqual([
      "space.restore",
    ]);
    expect(harness.restore).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "A Space named Work already exists." }),
    );
    expect(harness.chats).toHaveBeenLastCalledWith({ cursor: null });
    toast.mockRestore();
  });
});
