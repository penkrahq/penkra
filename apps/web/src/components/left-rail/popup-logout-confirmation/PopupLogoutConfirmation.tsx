"use client";

import { useEffect, useId, useState } from "react";

import { AlertDialog, AlertDialogPopup } from "~/components/ui/alert-dialog";

import { ModalLogoutConfirmation } from "../modal-logout-confirmation/ModalLogoutConfirmation";

export interface PopupLogoutConfirmationProps {
  onConfirm: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

export function PopupLogoutConfirmation({
  onConfirm,
  onOpenChange,
  open,
}: PopupLogoutConfirmationProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setErrorMessage(null);
      setLoading(false);
    }
  }, [open]);

  const confirmLogout = async () => {
    if (loading) return;
    setErrorMessage(null);
    setLoading(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to log out.");
      setLoading(false);
    }
  };

  return (
    <AlertDialog
      onOpenChange={(nextOpen) => {
        if (!loading) onOpenChange(nextOpen);
      }}
      open={open}
    >
      <AlertDialogPopup
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        backdropClassName="bg-[#000000b3]"
        bottomStickOnMobile={false}
        className="h-[220px] w-[400px] max-w-[calc(100vw-32px)] rounded-none border-0 bg-transparent p-0 shadow-none"
        data-pencil-component="hSE1M"
      >
        <ModalLogoutConfirmation
          className="max-w-full"
          descriptionId={descriptionId}
          errorMessage={errorMessage}
          loading={loading}
          onCancel={() => onOpenChange(false)}
          onConfirm={() => void confirmLogout()}
          titleId={titleId}
        />
      </AlertDialogPopup>
    </AlertDialog>
  );
}
