import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { OnboardingApiKey } from "./api-key/OnboardingApiKey";
import { OnboardingConnectAgent } from "./connect-agent/OnboardingConnectAgent";

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
    await page.getByRole("button", { name: "Continue" }).click();
    expect(onContinue).toHaveBeenCalledWith("sk-local", "Production");
  });
});
