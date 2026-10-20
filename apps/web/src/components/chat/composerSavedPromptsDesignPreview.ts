// FILE: composerSavedPromptsDesignPreview.ts
// Purpose: TEMPORARY design-review data for ComposerSavedPrompts (P24). Local only: restore and
//          delete just remove the row. Deleted when P24 wires the thread's server-side list.

import { useCallback, useState } from "react";

import type { ComposerSavedPrompt } from "./ComposerSavedPrompts";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const SAMPLE_PROMPTS: ReadonlyArray<ComposerSavedPrompt> = [
  {
    messageId: "preview-1",
    text: "Refactor the sidebar so archived threads collapse into one row per folder",
    attachments: [],
    savedAt: ago(120),
  },
  {
    messageId: "preview-2",
    text: "Check these screenshots against the spacing spec\nand list every mismatch",
    attachments: [{ name: "sidebar-before.png" }, { name: "sidebar-after.png" }],
    savedAt: ago(60 * 26),
  },
  {
    messageId: "preview-3",
    text: "",
    attachments: [{ name: "weekly-report.pdf" }],
    savedAt: ago(60 * 24 * 3),
  },
];

export function useComposerSavedPromptsDesignPreview() {
  const [prompts, setPrompts] = useState<ReadonlyArray<ComposerSavedPrompt>>(SAMPLE_PROMPTS);
  const remove = useCallback(
    (messageId: string) =>
      setPrompts((current) => current.filter((prompt) => prompt.messageId !== messageId)),
    [],
  );
  const onRestore = useCallback(
    (messageId: string) => {
      remove(messageId);
      return true;
    },
    [remove],
  );
  return { prompts, onRestore, onDelete: remove, shortcutLabel: "⌘S" } as const;
}
