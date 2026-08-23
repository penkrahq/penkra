import type { FolderId, ThreadId } from "@penkra/contracts";
import { create } from "zustand";

export type SidebarInlineRenameEditor =
  | { kind: "folder"; folderId: FolderId; value: string }
  | { kind: "thread"; threadId: ThreadId; value: string };
export type SidebarInlineRenameTarget =
  | { kind: "folder"; folderId: FolderId }
  | { kind: "thread"; threadId: ThreadId };

interface SidebarInlineRenameState {
  editor: SidebarInlineRenameEditor | null;
  cancel: () => void;
  finish: (target: SidebarInlineRenameTarget) => void;
  startFolder: (folderId: FolderId, value: string) => void;
  startThread: (threadId: ThreadId, value: string) => void;
  updateValue: (value: string) => void;
}

function isSameTarget(
  editor: SidebarInlineRenameEditor,
  target: SidebarInlineRenameTarget,
): boolean {
  return editor.kind === "folder" && target.kind === "folder"
    ? editor.folderId === target.folderId
    : editor.kind === "thread" && target.kind === "thread"
      ? editor.threadId === target.threadId
      : false;
}

export const useSidebarInlineRenameStore = create<SidebarInlineRenameState>((set) => ({
  editor: null,
  cancel: () => set({ editor: null }),
  finish: (target) =>
    set((state) => ({
      editor: state.editor && isSameTarget(state.editor, target) ? null : state.editor,
    })),
  startFolder: (folderId, value) => set({ editor: { kind: "folder", folderId, value } }),
  startThread: (threadId, value) => set({ editor: { kind: "thread", threadId, value } }),
  updateValue: (value) =>
    set((state) => ({ editor: state.editor ? { ...state.editor, value } : null })),
}));
