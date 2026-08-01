import { type BrowserWindow, dialog } from "electron";
import type { DesktopConfirmOptions } from "@penkra/contracts";

const CONFIRM_BUTTON_INDEX = 1;

export async function showDesktopConfirmDialog(
  input: string | DesktopConfirmOptions,
  ownerWindow: BrowserWindow | null,
): Promise<boolean> {
  const normalizedInput = typeof input === "string" ? { message: input } : input;
  const normalizedMessage = normalizedInput.message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  const options = {
    type: normalizedInput.type ?? ("question" as const),
    buttons: [normalizedInput.cancelLabel ?? "No", normalizedInput.confirmLabel ?? "Yes"],
    defaultId: CONFIRM_BUTTON_INDEX,
    cancelId: 0,
    noLink: true,
    message: normalizedMessage,
    ...(normalizedInput.title ? { title: normalizedInput.title } : {}),
    ...(normalizedInput.detail ? { detail: normalizedInput.detail } : {}),
  };
  const result = ownerWindow
    ? await dialog.showMessageBox(ownerWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === CONFIRM_BUTTON_INDEX;
}
