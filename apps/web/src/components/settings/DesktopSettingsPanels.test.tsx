// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppSettingsSchema } from "~/appSettings";

const harness = vi.hoisted(() => ({
  readPermission: vi.fn(() => "default"),
  requestPermission: vi.fn(),
  toastAdd: vi.fn(),
}));
vi.mock("~/env", () => ({ isElectron: false }));
vi.mock("~/notifications/taskCompletion", () => ({
  buildNotificationSettingsSupportText: (permission: string) => `Permission: ${permission}`,
  readBrowserNotificationPermissionState: harness.readPermission,
  requestBrowserNotificationPermission: harness.requestPermission,
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: harness.toastAdd } }));
import { NotificationsSettingsPanel } from "./DesktopSettingsPanels";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  harness.readPermission.mockReturnValue("default");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

it("reads permission at mount and retains it across unrelated renders", () => {
  harness.readPermission.mockReturnValue("granted");
  const settings = AppSettingsSchema.makeUnsafe({});
  const updateSettings = vi.fn();
  act(() =>
    root.render(
      <NotificationsSettingsPanel
        active
        settings={settings}
        defaults={settings}
        updateSettings={updateSettings}
      />,
    ),
  );
  expect(container.textContent).toContain("Permission: granted");
  act(() =>
    root.render(
      <NotificationsSettingsPanel
        active
        settings={{ ...settings, enableTaskCompletionToasts: false }}
        defaults={settings}
        updateSettings={updateSettings}
      />,
    ),
  );
  expect(harness.readPermission).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Permission: granted");
});

it.each(["granted", "denied"] as const)(
  "updates from the permission request result %s",
  async (permission) => {
    let resolvePermission!: (value: string) => void;
    harness.requestPermission.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const settings = AppSettingsSchema.makeUnsafe({
      enableSystemTaskCompletionNotifications: false,
    });
    const updateSettings = vi.fn();
    act(() =>
      root.render(
        <NotificationsSettingsPanel
          active
          settings={settings}
          defaults={settings}
          updateSettings={updateSettings}
        />,
      ),
    );
    expect(container.textContent).toContain("Permission: default");
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Desktop activity notifications"]')!
        .click(),
    );
    expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();
    await act(async () => resolvePermission(permission));
    expect(container.textContent).toContain(`Permission: ${permission}`);
    expect(updateSettings).toHaveBeenCalledWith({
      enableSystemTaskCompletionNotifications: permission === "granted",
    });
    if (permission === "denied")
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ type: "warning", title: "Desktop notifications unavailable" }),
      );
    else expect(harness.toastAdd).not.toHaveBeenCalled();
  },
);
