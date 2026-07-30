import type { ReactNode } from "react";

import { Dialog, DialogPopup } from "~/components/ui/dialog";

import { ModalSettings, type SettingsPage } from "./ModalSettings";

export interface SettingsDialogProps {
  children?: ReactNode;
  onClose: () => void;
  onPageChange?: (page: SettingsPage) => void;
  page?: SettingsPage;
}

export function SettingsDialog({
  children,
  onClose,
  onPageChange,
  page = "general",
}: SettingsDialogProps) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogPopup
        aria-label="Settings"
        backdropClassName="bg-[#000000b3]"
        bottomStickOnMobile={false}
        className="h-[640px] w-[880px] max-h-[calc(100svh-48px)] max-w-[calc(100vw-48px)] rounded-none border-[color:var(--color-border)] bg-[var(--color-background-surface)] p-0 shadow-none"
        data-pencil-overlay="settings"
        showCloseButton={false}
      >
        <ModalSettings
          className="h-full w-full rounded-none border-0"
          page={page}
          {...(onPageChange ? { onPageChange } : {})}
        >
          {children}
        </ModalSettings>
      </DialogPopup>
    </Dialog>
  );
}
