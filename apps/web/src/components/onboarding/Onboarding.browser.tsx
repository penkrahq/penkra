import "../../index.css";

import type { DesktopBridge } from "@penkra/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const connectionApi = vi.hoisted(() => ({
  getConnections: vi.fn(),
  beginConnectionLogin: vi.fn(),
  cancelConnectionLogin: vi.fn(),
  createStaticConnection: vi.fn(),
  getConnectionLogin: vi.fn(),
  terminateConnection: vi.fn(),
  openExternal: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    dialogs: { confirm: connectionApi.confirm },
    provider: {
      beginConnectionLogin: connectionApi.beginConnectionLogin,
      cancelConnectionLogin: connectionApi.cancelConnectionLogin,
      createStaticConnection: connectionApi.createStaticConnection,
      getConnectionLogin: connectionApi.getConnectionLogin,
      getConnections: connectionApi.getConnections,
      terminateConnection: connectionApi.terminateConnection,
    },
    shell: { openExternal: connectionApi.openExternal },
  }),
}));

import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
  resolveThemePack,
} from "../../theme/theme.logic";
import { OnboardingConnectAgent } from "./connect-agent/OnboardingConnectAgent";
import { DesktopOnboardingGate } from "./DesktopOnboardingGate";
import { OnboardingWelcome } from "./welcome/OnboardingWelcome";

function resolveCssColor(value: string): string {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}

describe("Pencil onboarding", () => {
  beforeEach(() => {
    connectionApi.getConnections.mockResolvedValue({
      connections: [],
      installations: ["opencode", "claudeAgent", "codex"].map((harness, index) => ({
        id: `installation-${index}`,
        harness,
        version: "1.0.0",
        platform: "darwin",
        architecture: "arm64",
        adapterVersion: "1",
        protocolVersion: "1",
        lifecycle: "active",
        healthReason: null,
        installedAt: "2026-08-09T00:00:00.000Z",
        activatedAt: "2026-08-09T00:00:00.000Z",
        retiredAt: null,
      })),
      anonymousRoutes: [{ harness: "opencode", internalProviderId: "opencode" }],
      authenticationMethods: [
        {
          harness: "claudeAgent",
          authenticationTargetId: "anthropic-first-party",
          authenticationMethodId: "claude-account",
          kind: "managed-login",
          label: "Sign in",
          internalProviderIds: [null],
        },
        {
          harness: "claudeAgent",
          authenticationTargetId: "anthropic-first-party",
          authenticationMethodId: "api-key",
          kind: "static-secret",
          label: "API key",
          secretPlaceholder: "Anthropic API key",
          internalProviderIds: [null],
        },
        {
          harness: "codex",
          authenticationTargetId: "openai-first-party",
          authenticationMethodId: "chatgpt",
          kind: "managed-login",
          label: "Sign in",
          internalProviderIds: [null],
        },
        {
          harness: "codex",
          authenticationTargetId: "openai-first-party",
          authenticationMethodId: "api-key",
          kind: "managed-secret",
          label: "API key",
          secretPlaceholder: "OpenAI API key",
          internalProviderIds: [null],
        },
        {
          harness: "opencode",
          authenticationTargetId: "opencode-go",
          authenticationMethodId: "api-key",
          kind: "static-secret",
          label: "OpenCode Go",
          secretPlaceholder: "OpenCode Go key",
          internalProviderIds: ["opencode-go"],
        },
      ],
    });
    const theme = buildThemeCssVariables(resolveThemePack(DEFAULT_THEME_STATE, "dark"), "dark");
    for (const [name, value] of Object.entries(theme.variables)) {
      document.documentElement.style.setProperty(name, value);
    }
  });

  it("shows the genuine unconfigured state and never gates Continue", async () => {
    const onContinue = vi.fn();
    await render(<OnboardingConnectAgent onContinue={onContinue} />);

    const continueButton = page.getByRole("button", { name: "Continue" });
    await expect.element(page.getByText("Connect your agents")).toBeVisible();
    await expect.element(page.getByText("No connections yet").first()).toBeVisible();
    await expect.element(continueButton).toBeEnabled();
    await continueButton.click();
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("starts the real inline Connection sign-in during onboarding", async () => {
    await render(<OnboardingConnectAgent />);

    await page.getByRole("button", { name: "Sign in" }).click();
    await vi.waitFor(() => expect(connectionApi.beginConnectionLogin).toHaveBeenCalledOnce());
  });

  it("keeps the onboarding frame distinct from the launch canvas across themes", async () => {
    await render(<OnboardingWelcome />);

    const frame = document.querySelector<HTMLElement>("[data-onboarding-frame]");
    expect(frame).not.toBeNull();

    const darkFrame = getComputedStyle(frame!).backgroundColor;
    const darkCanvas = resolveCssColor(
      getComputedStyle(document.documentElement).getPropertyValue("--background"),
    );
    expect(darkFrame).toBe("rgb(30, 30, 30)");
    expect(darkFrame).not.toBe(darkCanvas);

    const lightTheme = buildThemeCssVariables(
      resolveThemePack(DEFAULT_THEME_STATE, "light"),
      "light",
    );
    for (const [name, value] of Object.entries(lightTheme.variables)) {
      document.documentElement.style.setProperty(name, value);
    }

    const lightFrame = getComputedStyle(frame!).backgroundColor;
    const lightCanvas = resolveCssColor(
      getComputedStyle(document.documentElement).getPropertyValue("--background"),
    );
    expect(lightFrame).toBe("rgb(249, 249, 249)");
    expect(lightFrame).not.toBe(lightCanvas);
  });

  it("keeps the welcome provider icons in a compact row", async () => {
    await render(<OnboardingWelcome />);

    const row = document.querySelector<HTMLElement>('[aria-label="Supported agents"]');
    expect(row).not.toBeNull();
    const icons = Array.from(row!.children) as HTMLElement[];
    expect(icons).toHaveLength(6);

    const first = icons[0]!.getBoundingClientRect();
    const second = icons[1]!.getBoundingClientRect();
    const last = icons.at(-1)!.getBoundingClientRect();
    expect(Math.round(second.left - first.right)).toBe(14);
    expect(Math.round(last.right - first.left)).toBe(202);
  });

  it("keeps the initial account check visually quiet", async () => {
    const bridge = {
      accountAuth: {
        getState: vi.fn(() => new Promise(() => undefined)),
        requestSignIn: vi.fn(),
        requestSignUp: vi.fn(),
        signOut: vi.fn(),
        onCallbackStarted: vi.fn(() => () => undefined),
        onAuthenticated: vi.fn(() => () => undefined),
        onUserUpdated: vi.fn(() => () => undefined),
        onError: vi.fn(() => () => undefined),
      },
    } as unknown as DesktopBridge;

    await render(
      <DesktopOnboardingGate bridge={bridge}>
        <p>Application shell</p>
      </DesktopOnboardingGate>,
    );

    await expect.element(page.getByText("Preparing Penkra")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("status", { name: "Preparing Penkra" }))
      .toHaveAttribute("aria-busy", "true");
  });

  it("starts processing only after the sign-up callback returns", async () => {
    const requestSignUp = vi.fn().mockResolvedValue(undefined);
    let notifyCallbackStarted:
      | ((callback: { intent: "sign-in" | "sign-up" | null }) => void)
      | undefined;
    let notifyAuthenticated:
      | ((user: { id: string; email: string; name: string; image: string | null }) => void)
      | undefined;
    let notifyError: ((error: { message: string }) => void) | undefined;
    const bridge = {
      accountAuth: {
        getState: vi.fn().mockResolvedValue({ status: "unauthenticated" }),
        requestSignIn: vi.fn().mockResolvedValue(undefined),
        requestSignUp,
        signOut: vi.fn().mockResolvedValue(undefined),
        onCallbackStarted: vi.fn((listener) => {
          notifyCallbackStarted = listener;
          return () => undefined;
        }),
        onAuthenticated: vi.fn((listener) => {
          notifyAuthenticated = listener;
          return () => undefined;
        }),
        onUserUpdated: vi.fn(() => () => undefined),
        onError: vi.fn((listener) => {
          notifyError = listener;
          return () => undefined;
        }),
      },
    } as unknown as DesktopBridge;

    await render(
      <DesktopOnboardingGate bridge={bridge}>
        <p>Application shell</p>
      </DesktopOnboardingGate>,
    );

    await expect.element(page.getByText("Welcome to Penkra")).toBeVisible();
    const createAccountButton = page.getByRole("button", {
      name: "Create an account",
    });
    const signInButton = page.getByRole("button", { name: "Sign in" });
    await createAccountButton.click();
    await expect.element(page.getByText("Welcome to Penkra")).toBeVisible();
    await expect.element(createAccountButton).not.toHaveAttribute("aria-busy");
    await expect.element(createAccountButton).toBeEnabled();
    await expect.element(signInButton).toBeEnabled();
    expect(requestSignUp).toHaveBeenCalledOnce();
    await expect.element(page.getByText("Application shell")).not.toBeInTheDocument();

    notifyCallbackStarted?.({ intent: "sign-up" });
    const creatingAccountButton = page.getByRole("button", {
      name: "Creating account…",
    });
    await expect.element(creatingAccountButton).toHaveAttribute("aria-busy", "true");
    await expect.element(creatingAccountButton).toBeDisabled();
    await expect.element(signInButton).toBeDisabled();
    const rootStyle = getComputedStyle(document.documentElement);
    const creatingAccountStyle = getComputedStyle(creatingAccountButton.element());
    expect(creatingAccountStyle.backgroundColor).toBe(
      resolveCssColor(rootStyle.getPropertyValue("--color-background-button-secondary-active")),
    );
    expect(creatingAccountStyle.borderColor).toBe(
      resolveCssColor(rootStyle.getPropertyValue("--color-border-heavy")),
    );
    expect(creatingAccountStyle.color).toBe(
      resolveCssColor(rootStyle.getPropertyValue("--color-text-foreground-secondary")),
    );

    notifyError?.({ message: "Authentication was cancelled." });
    await expect.element(creatingAccountButton).not.toBeInTheDocument();
    await expect.element(createAccountButton).toBeEnabled();
    await expect.element(signInButton).toBeEnabled();

    notifyCallbackStarted?.({ intent: "sign-up" });
    notifyAuthenticated?.({
      id: "user-1",
      email: "person@example.com",
      name: "Person",
      image: null,
    });
    await expect.element(page.getByText("Connect your agents")).toBeVisible();
    await expect.element(page.getByText("Application shell")).not.toBeInTheDocument();

    await page.getByRole("button", { name: "Continue" }).click();
    await expect.element(page.getByText("Application shell")).toBeVisible();
  });

  it("enters the application after an existing account signs in", async () => {
    let notifyCallbackStarted:
      | ((callback: { intent: "sign-in" | "sign-up" | null }) => void)
      | undefined;
    let notifyAuthenticated:
      | ((user: { id: string; email: string; name: string; image: string | null }) => void)
      | undefined;
    const bridge = {
      accountAuth: {
        getState: vi.fn().mockResolvedValue({ status: "unauthenticated" }),
        requestSignIn: vi.fn().mockResolvedValue(undefined),
        requestSignUp: vi.fn().mockResolvedValue(undefined),
        signOut: vi.fn().mockResolvedValue(undefined),
        onCallbackStarted: vi.fn((listener) => {
          notifyCallbackStarted = listener;
          return () => undefined;
        }),
        onAuthenticated: vi.fn((listener) => {
          notifyAuthenticated = listener;
          return () => undefined;
        }),
        onUserUpdated: vi.fn(() => () => undefined),
        onError: vi.fn(() => () => undefined),
      },
    } as unknown as DesktopBridge;

    await render(
      <DesktopOnboardingGate bridge={bridge}>
        <p>Application shell</p>
      </DesktopOnboardingGate>,
    );

    const createAccountButton = page.getByRole("button", {
      name: "Create an account",
    });
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect
      .element(page.getByRole("button", { name: "Sign in" }))
      .not.toHaveAttribute("aria-busy");
    notifyCallbackStarted?.({ intent: "sign-in" });
    const signingInButton = page.getByRole("button", { name: "Signing in…" });
    await expect.element(signingInButton).toHaveAttribute("aria-busy", "true");
    const rootStyle = getComputedStyle(document.documentElement);
    const signingInStyle = getComputedStyle(signingInButton.element());
    expect(signingInStyle.backgroundColor).toBe(
      resolveCssColor(rootStyle.getPropertyValue("--color-background-button-secondary-active")),
    );
    expect(signingInStyle.borderColor).toBe(
      resolveCssColor(rootStyle.getPropertyValue("--color-border-heavy")),
    );
    expect(signingInStyle.color).toBe(
      resolveCssColor(rootStyle.getPropertyValue("--color-text-foreground-tertiary")),
    );
    await expect.element(createAccountButton).toBeDisabled();
    const unavailableCreateAccountStyle = getComputedStyle(createAccountButton.element());
    expect(unavailableCreateAccountStyle.backgroundColor).toBe(
      resolveCssColor(rootStyle.getPropertyValue("--color-background-button-secondary-active")),
    );
    expect(unavailableCreateAccountStyle.borderColor).toBe(
      resolveCssColor(rootStyle.getPropertyValue("--color-border")),
    );
    expect(unavailableCreateAccountStyle.color).toBe(
      resolveCssColor(rootStyle.getPropertyValue("--color-text-foreground-tertiary")),
    );
    notifyAuthenticated?.({
      id: "user-1",
      email: "person@example.com",
      name: "Person",
      image: null,
    });
    await expect.element(page.getByText("Application shell")).toBeVisible();
  });

  it("enters the application when an account session already exists", async () => {
    const bridge = {
      accountAuth: {
        getState: vi.fn().mockResolvedValue({
          status: "authenticated",
          user: {
            id: "user-1",
            email: "person@example.com",
            name: "Person",
            image: null,
          },
        }),
        requestSignIn: vi.fn(),
        requestSignUp: vi.fn(),
        signOut: vi.fn(),
        onCallbackStarted: vi.fn(() => () => undefined),
        onAuthenticated: vi.fn(() => () => undefined),
        onUserUpdated: vi.fn(() => () => undefined),
        onError: vi.fn(() => () => undefined),
      },
    } as unknown as DesktopBridge;

    await render(
      <DesktopOnboardingGate bridge={bridge}>
        <p>Application shell</p>
      </DesktopOnboardingGate>,
    );

    await expect.element(page.getByText("Application shell")).toBeVisible();
  });

  it("keeps account verification errors distinct from signed-out state and retries", async () => {
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ status: "error", message: "Account service unavailable." })
      .mockResolvedValueOnce({
        status: "authenticated",
        user: {
          id: "user-1",
          email: "person@example.com",
          name: "Person",
          image: null,
        },
      });
    const bridge = {
      accountAuth: {
        getState,
        requestSignIn: vi.fn(),
        requestSignUp: vi.fn(),
        signOut: vi.fn(),
        onCallbackStarted: vi.fn(() => () => undefined),
        onAuthenticated: vi.fn(() => () => undefined),
        onUserUpdated: vi.fn(() => () => undefined),
        onError: vi.fn(() => () => undefined),
      },
    } as unknown as DesktopBridge;

    await render(
      <DesktopOnboardingGate bridge={bridge}>
        <p>Application shell</p>
      </DesktopOnboardingGate>,
    );

    await expect.element(page.getByText("Penkra couldn't verify your account.")).toBeVisible();
    await expect.element(page.getByText("Welcome to Penkra")).not.toBeInTheDocument();

    await page.getByRole("button", { name: "Retry" }).click();
    await expect.element(page.getByText("Application shell")).toBeVisible();
    expect(getState).toHaveBeenCalledTimes(2);
  });
});
