import { describe, expect, it } from "vitest";

import { SpaceId } from "@penkra/contracts";
import type { ComposerThreadMentionSource, Project } from "../types";
import { buildThreadMentionComposerItems } from "./useComposerCommandMenuItems";

function project(id: string, name: string): Project {
  return {
    id,
    spaceId: SpaceId.makeUnsafe("space-test"),
    name,
    remoteName: name,
    folderName: name,
    localName: null,
    cwd: `/workspace/${id}`,
    defaultModelSelection: null,
    expanded: true,
    scripts: [],
  } as unknown as Project;
}

function thread(input: {
  id: string;
  folderId: string;
  title: string;
  provider?: "codex" | "claudeAgent";
  updatedAt?: string;
  archivedAt?: string | null;
}): ComposerThreadMentionSource {
  return {
    id: input.id,
    folderId: input.folderId,
    title: input.title,
    provider: input.provider ?? "codex",
    createdAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt,
    archivedAt: input.archivedAt ?? null,
    latestUserMessageAt: null,
  } as unknown as ComposerThreadMentionSource;
}

describe("buildThreadMentionComposerItems", () => {
  const folders = [
    project("folder", "Penkra"),
    project("chats", "Chats"),
    project("artwork", "Artwork"),
  ];

  it("searches titles across project and chat sections and excludes the current thread", () => {
    const items = buildThreadMentionComposerItems({
      folders,
      currentThreadId: "current",
      query: "release",
      threads: [
        thread({ id: "current", folderId: "folder", title: "Release current" }),
        thread({ id: "project-thread", folderId: "folder", title: "Release Penkra" }),
        thread({ id: "chat-thread", folderId: "chats", title: "Release notes" }),
        thread({
          id: "artwork-thread",
          folderId: "artwork",
          title: "Release artwork",
          provider: "claudeAgent",
        }),
        thread({ id: "unrelated", folderId: "folder", title: "Bug triage" }),
      ],
    });

    expect(items.map((item) => item.id).toSorted()).toEqual([
      "thread:artwork-thread",
      "thread:chat-thread",
      "thread:project-thread",
    ]);
    expect(Object.fromEntries(items.map((item) => [item.id, item.description]))).toEqual({
      "thread:chat-thread": "Chats",
      "thread:project-thread": "Penkra",
      "thread:artwork-thread": "Artwork",
    });
    expect(items.find((item) => item.id === "thread:artwork-thread")).toMatchObject({
      provider: "claudeAgent",
      mention: { name: "Release artwork", path: "thread://artwork-thread" },
    });
  });

  it("caps the unfiltered list to the 20 most recent active threads", () => {
    const threads = Array.from({ length: 24 }, (_, index) =>
      thread({
        id: `thread-${index}`,
        folderId: "folder",
        title: index === 23 ? "" : `Thread ${index}`,
        updatedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        archivedAt: index === 22 ? "2026-02-01T00:00:00.000Z" : null,
      }),
    );
    const items = buildThreadMentionComposerItems({
      folders,
      currentThreadId: null,
      query: "",
      threads,
    });

    expect(items).toHaveLength(20);
    expect(items[0]).toMatchObject({ label: "Untitled thread", id: "thread:thread-23" });
    expect(items.some((item) => item.id === "thread:thread-22")).toBe(false);
    expect(items.at(-1)?.id).toBe("thread:thread-3");
  });

  it("caps query-filtered results to the suggestion limit", () => {
    const threads = Array.from({ length: 30 }, (_, index) =>
      thread({ id: `thread-${index}`, folderId: "folder", title: `Release ${index}` }),
    );
    const items = buildThreadMentionComposerItems({
      folders,
      currentThreadId: null,
      query: "release",
      threads,
    });

    expect(items).toHaveLength(20);
  });

  it("disambiguates duplicate titles with the project name so mention tokens stay unique", () => {
    const items = buildThreadMentionComposerItems({
      folders,
      currentThreadId: null,
      query: "planning",
      threads: [
        thread({ id: "in-project", folderId: "folder", title: "Planning" }),
        thread({ id: "in-chats", folderId: "chats", title: "Planning" }),
        thread({ id: "unique", folderId: "folder", title: "Planning extras" }),
      ],
    });

    const mentionNamesById = Object.fromEntries(
      items.map((item) => [item.id, item.type === "thread" ? item.mention.name : null]),
    );
    expect(mentionNamesById["thread:in-project"]).toBe("Planning (Penkra)");
    expect(mentionNamesById["thread:in-chats"]).toBe("Planning (Chats)");
    expect(mentionNamesById["thread:unique"]).toBe("Planning extras");
    expect(items.every((item) => item.label.startsWith("Planning"))).toBe(true);
  });

  it("falls back to a thread-id suffix for duplicate titles inside the same project", () => {
    const items = buildThreadMentionComposerItems({
      folders,
      currentThreadId: null,
      query: "planning",
      threads: [
        thread({ id: "thread-aaa111", folderId: "folder", title: "Planning" }),
        thread({ id: "thread-bbb222", folderId: "folder", title: "Planning" }),
      ],
    });

    const names = items.map((item) => (item.type === "thread" ? item.mention.name : "")).toSorted();
    expect(names).toEqual(["Planning (Penkra, aaa111)", "Planning (Penkra, bbb222)"]);
  });

  it("keeps generated names unique when a qualified name matches another real title", () => {
    const items = buildThreadMentionComposerItems({
      folders,
      currentThreadId: null,
      query: "planning",
      threads: [
        thread({ id: "thread-111111", folderId: "folder", title: "Planning" }),
        thread({ id: "thread-222222", folderId: "chats", title: "Planning" }),
        thread({
          id: "thread-333333",
          folderId: "folder",
          title: "Planning (Penkra)",
        }),
      ],
    });

    const names = items.map((item) => (item.type === "thread" ? item.mention.name : ""));
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length);
    expect(names).toContain("Planning (Penkra) (111111)");
    expect(names).toContain("Planning (Penkra) (333333)");
  });

  it("treats casing-only title differences as the same mention token", () => {
    const items = buildThreadMentionComposerItems({
      folders,
      currentThreadId: null,
      query: "release",
      threads: [
        thread({ id: "thread-aaaaaa", folderId: "folder", title: "Release" }),
        thread({ id: "thread-bbbbbb", folderId: "folder", title: "release" }),
      ],
    });

    const names = items.map((item) => (item.type === "thread" ? item.mention.name : ""));
    expect(names).toEqual(["Release (aaaaaa)", "release (bbbbbb)"]);
  });
});
