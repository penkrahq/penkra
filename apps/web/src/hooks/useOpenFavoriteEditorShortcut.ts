// FILE: useOpenFavoriteEditorShortcut.ts
// Purpose: Register the global "open favorite editor" keyboard shortcut independently from
//          editor-launch UI. Mount it once from an always-present host and gate it with `enabled`.
// Layer: Chat editor action hook

import type { EditorId, ResolvedKeybindingsConfig } from "@penkra/contracts";
import { useEffect } from "react";

import { usePreferredEditor } from "../editorPreferences";
import { isOpenFavoriteEditorShortcut } from "../keybindings";
import { readNativeApi } from "../nativeApi";

export function useOpenFavoriteEditorShortcut({
  keybindings,
  availableEditors,
  openInTarget,
  enabled: enabledProp,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInTarget: string | null;
  /** When false the listener is not registered (e.g. temporary threads with no project). */
  enabled?: boolean;
}): void {
  const enabled = enabledProp ?? true;
  const [preferredEditor] = usePreferredEditor(availableEditors);

  useEffect(() => {
    if (!enabled) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      const api = readNativeApi();
      if (!api || !openInTarget || !preferredEditor) return;
      e.preventDefault();
      void api.shell.openInEditor(openInTarget, preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, preferredEditor, keybindings, openInTarget]);
}
