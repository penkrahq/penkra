import "../index.css";

import type { ServerConfigUpdatedPayload } from "@penkra/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { createFullscreenTestHost } from "../test/browserHarness";
import {
  ServerConfigUpdateNotifications,
  type ServerConfigUpdateSubscription,
} from "./ServerConfigUpdateNotifications";
import { ToastProvider } from "./ui/toast";

let latestPayload: ServerConfigUpdatedPayload | null = null;
let listener: Parameters<ServerConfigUpdateSubscription>[0] | null = null;
let subscribed = false;

const markSubscribed = () => {
  subscribed = true;
};

const subscribeForTest: ServerConfigUpdateSubscription = (nextListener) => {
  listener = nextListener;
  if (latestPayload) nextListener(latestPayload);
  return () => {
    if (listener === nextListener) listener = null;
  };
};

function pushUpdate(issues: ServerConfigUpdatedPayload["issues"]): void {
  latestPayload = { issues, providers: [] };
  listener?.(latestPayload);
}

function toastTitles(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="toast-title"]')).map(
    (element) => element.textContent ?? "",
  );
}

async function expectToast(title: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(toastTitles()).toContain(title);
    },
    { timeout: 4_000, interval: 16 },
  );
}

async function mountNotifications(): Promise<() => Promise<void>> {
  const host = createFullscreenTestHost();
  const queryClient = new QueryClient();
  const routeTree = createRootRoute({
    component: () => (
      <ToastProvider position="top-center">
        <ServerConfigUpdateNotifications
          onSubscribed={markSubscribed}
          subscribe={subscribeForTest}
        />
      </ToastProvider>
    ),
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
    { container: host },
  );

  try {
    await vi.waitFor(() => expect(subscribed).toBe(true), {
      timeout: 4_000,
      interval: 16,
    });
  } catch (cause) {
    await screen.unmount();
    host.remove();
    throw cause;
  }

  let cleanedUp = false;
  return async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await screen.unmount();
    host.remove();
  };
}

describe("Keybindings update toast", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    latestPayload = null;
    listener = null;
    subscribed = false;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not show success toasts for passive keybinding reloads", async () => {
    const cleanup = await mountNotifications();
    try {
      pushUpdate([]);
      pushUpdate([]);
      expect(toastTitles()).not.toContain("Keybindings updated");
    } finally {
      await cleanup();
    }
  });

  it("shows a warning toast when keybinding config has issues", async () => {
    const cleanup = await mountNotifications();
    try {
      pushUpdate([{ kind: "keybindings.malformed-config", message: "Expected JSON array" }]);
      await expectToast("Invalid keybindings configuration");
    } finally {
      await cleanup();
    }
  });

  it("does not show a toast from the replayed cached value on subscribe", async () => {
    const issue = [{ kind: "keybindings.malformed-config", message: "Expected JSON array" }];
    latestPayload = { issues: issue, providers: [] };

    const cleanup = await mountNotifications();
    try {
      expect(toastTitles()).not.toContain("Invalid keybindings configuration");

      pushUpdate(issue);
      await expectToast("Invalid keybindings configuration");
    } finally {
      await cleanup();
    }
  });
});
