// FILE: AdvancedSettingsPanel.browser.tsx
// Purpose: Browser characterization for advanced-settings ownership and disclosure behavior.
// Layer: Browser UI test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  config: {
    keybindingsConfigPath: "/tmp/keybindings.json",
    availableEditors: [],
  },
  auth: { authenticated: true, role: "client" },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly string[] }) => ({
    data: options.queryKey[0] === "config" ? harness.config : harness.auth,
  }),
}));

vi.mock("~/lib/serverReactQuery", () => ({
  serverConfigQueryOptions: () => ({ queryKey: ["config"] }),
  serverAuthSessionQueryOptions: () => ({ queryKey: ["auth"] }),
}));

import { AdvancedSettingsPanel } from "./AdvancedSettingsPanel";

describe("AdvancedSettingsPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps browser session, keybindings and release-history controls without journal recovery", async () => {
    const onOpenReleaseHistory = vi.fn();
    await render(
      <AdvancedSettingsPanel active onOpenReleaseHistory={onOpenReleaseHistory} resetEpoch={0} />,
    );

    expect(document.body.textContent).toContain("Authenticated as client.");
    expect(document.body.textContent).not.toContain("Recovery tools");
    expect(page.getByRole("button", { name: "Open file" }).element()).toBeTruthy();
    await page.getByRole("button", { name: "View release history" }).click();
    expect(onOpenReleaseHistory).toHaveBeenCalledOnce();
  });
});
