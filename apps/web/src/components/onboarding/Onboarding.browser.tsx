import "../../index.css";

import type { DesktopBridge } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { OnboardingApiKey } from "./api-key/OnboardingApiKey";
import { OnboardingConnectAgent } from "./connect-agent/OnboardingConnectAgent";
import { DesktopOnboardingGate } from "./DesktopOnboardingGate";
import { OnboardingHqAuth } from "./hq-auth/OnboardingHqAuth";

describe("Pencil onboarding", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("requires and returns a selected agent", async () => {
    const onContinue = vi.fn();
    await render(<OnboardingConnectAgent onContinue={onContinue} />);

    const continueButton = page.getByRole("button", { name: "Continue" });
    await expect.element(continueButton).toBeDisabled();
    await page.getByRole("button", { name: "Codex" }).click();
    await expect.element(continueButton).toBeEnabled();
    await continueButton.click();
    expect(onContinue).toHaveBeenCalledWith(["codex"]);
  });

  it("keeps API key fields native and editable", async () => {
    const onContinue = vi.fn();
    await render(<OnboardingApiKey onContinue={onContinue} />);

    await page.getByLabelText("API key").fill("sk-local");
    await page.getByRole("textbox", { name: "Key name" }).fill("Production");
    await page.getByRole("button", { name: "Save" }).click();
    expect(onContinue).toHaveBeenCalledWith("sk-local", "Production");
  });

  it("submits HQ authentication through a native password form", async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: "Authentication failed." })
      .mockResolvedValueOnce({ ok: true });
    await render(<OnboardingHqAuth onSubmit={onSubmit} />);

    const password = page.getByLabelText("Master password");
    await password.fill("wrong");
    await page.getByRole("button", { name: "Connect" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Authentication failed.");

    await password.fill("correct");
    await page.getByRole("button", { name: "Connect" }).click();
    expect(onSubmit).toHaveBeenLastCalledWith("correct");
  });

  it("gates the app only when desktop HQ authentication is required", async () => {
    const skip = vi.fn().mockResolvedValue(undefined);
    const bridge = {
      hqAuth: {
        getRequired: vi.fn().mockResolvedValue(true),
        skip,
        submit: vi.fn(),
      },
    } as unknown as DesktopBridge;

    await render(
      <DesktopOnboardingGate bridge={bridge}>
        <p>Application shell</p>
      </DesktopOnboardingGate>,
    );

    await expect.element(page.getByText("Welcome to Penkra")).toBeVisible();
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect.element(page.getByText("Application shell")).toBeVisible();
    expect(skip).toHaveBeenCalledOnce();
  });
});
