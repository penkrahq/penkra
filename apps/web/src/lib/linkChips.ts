import { readNativeApi } from "~/nativeApi";
import { normalizeComposerLinkUrl } from "@penkra/shared/linkChips";
export * from "@penkra/shared/linkChips";

/** Opens a URL in the user's external browser, falling back to a new tab. */
export function openExternalLink(url: string): void {
  const href = normalizeComposerLinkUrl(url) ?? url;
  const api = readNativeApi();
  if (api) {
    void api.shell.openExternal(href).catch(() => {
      window.open(href, "_blank", "noopener,noreferrer");
    });
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}
