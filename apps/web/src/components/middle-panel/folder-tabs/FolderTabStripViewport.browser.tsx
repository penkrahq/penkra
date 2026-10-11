import "../../../index.css";

import { page } from "vitest/browser";
import type { CSSProperties } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import {
  resolveAppsLauncherFolderBarReservationPx,
  resolveAppsLauncherRightInsetPx,
} from "../../chat/appsLauncher.logic";
import { FolderTabStripViewport } from "./FolderTabStripViewport";

function folderFixture(input: { isElectron: boolean; isWindowsDesktop: boolean }) {
  const appsLauncherRightInsetPx = resolveAppsLauncherRightInsetPx(input);
  const reservationPx = resolveAppsLauncherFolderBarReservationPx({
    appsLauncherRightInsetPx,
    dockOpen: false,
    ...input,
  });

  return (
    <div
      className="relative flex h-12 w-[800px]"
      data-testid="chat-shell"
      style={
        {
          "--apps-launcher-right-inset": `${appsLauncherRightInsetPx}px`,
          "--apps-launcher-folder-bar-right-reservation": `${reservationPx}px`,
        } as CSSProperties
      }
    >
      <FolderTabStripViewport>
        {Array.from({ length: 10 }, (_, index) => (
          <div
            key={index}
            className="flex h-8 w-[130px] shrink-0 items-center"
            data-testid={index === 9 ? "last-tab" : undefined}
          >
            Thread {index + 1}
          </div>
        ))}
      </FolderTabStripViewport>
      <button
        aria-label="Apps"
        className="absolute top-0 h-8 w-8"
        data-testid="apps-launcher"
        style={{ right: "var(--apps-launcher-right-inset)" }}
      />
    </div>
  );
}

describe("Folder tab strip launcher clearance", () => {
  it.each([
    { isElectron: false, isWindowsDesktop: false },
    { isElectron: true, isWindowsDesktop: true },
  ])(
    "keeps the last scrolled tab left of the launcher when closed ($isWindowsDesktop)",
    async (input) => {
      await page.viewport(1000, 800);
      await render(folderFixture(input));

      const strip = document.querySelector<HTMLElement>("[data-thread-folder-tab-strip]");
      const lastTab = document.querySelector<HTMLElement>('[data-testid="last-tab"]');
      const launcher = document.querySelector<HTMLElement>('[data-testid="apps-launcher"]');
      expect(strip).not.toBeNull();
      expect(lastTab).not.toBeNull();
      expect(launcher).not.toBeNull();
      strip!.scrollLeft = strip!.scrollWidth;

      expect(lastTab!.getBoundingClientRect().right).toBeLessThanOrEqual(
        launcher!.getBoundingClientRect().left,
      );
    },
  );
});
