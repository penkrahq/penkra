import "../../index.css";

import type { DesktopBridge } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
  resolveThemePack,
} from "../../theme/theme.logic";
import { OnboardingApiKey } from "./api-key/OnboardingApiKey";
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
    const theme = buildThemeCssVariables(resolveThemePack(DEFAULT_THEME_STATE, "dark"), "dark");
    for (const [name, value] of Object.entries(theme.variables)) {
      document.documentElement.style.setProperty(name, value);
    }
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("matches the Pencil default selection and returns selected agents", async () => {
    const onContinue = vi.fn();
    await render(<OnboardingConnectAgent onContinue={onContinue} />);

    const continueButton = page.getByRole("button", { name: "Continue" });
    await expect
      .element(page.getByRole("button", { name: "Claude" }))
      .toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByText("3 connections")).toBeVisible();
    await expect.element(continueButton).toBeEnabled();
    await page.getByRole("button", { name: "Codex" }).click();
    await continueButton.click();
    expect(onContinue).toHaveBeenCalledWith(["claude", "codex"]);
  });

  it("keeps API key fields native and editable", async () => {
    const onContinue = vi.fn();
    await render(<OnboardingApiKey onContinue={onContinue} />);

    await page.getByLabelText("API key").fill("sk-local");
    await page.getByRole("textbox", { name: "Key name" }).fill("Production");
    await page.getByRole("button", { name: "Save" }).click();
    expect(onContinue).toHaveBeenCalledWith("sk-local", "Production");
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
    await expect.element(page.getByText("Connect an agent to get started")).toBeVisible();
    await expect.element(page.getByText("Application shell")).not.toBeInTheDocument();
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
});
