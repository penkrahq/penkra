// FILE: _chat.apps.tsx
// Purpose: Registers Pencil's Apps gallery under the shared chat shell.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";
import { ModalAppsGallery } from "~/components/apps/modal-apps-gallery/ModalAppsGallery";

function AppsRoute() {
  return (
    <main className="flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden bg-[var(--color-background-surface)] p-4">
      <ModalAppsGallery className="max-h-full shadow-xl" />
    </main>
  );
}

export const Route = createFileRoute("/_chat/apps")({
  component: AppsRoute,
});
