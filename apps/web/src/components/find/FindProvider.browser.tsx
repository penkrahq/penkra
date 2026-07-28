// FILE: FindProvider.browser.tsx
// Purpose: Chromium interaction coverage for aggregate find counts, navigation, and live content.
// Layer: Browser regression tests

import { StrictMode, useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { ChatSearchBar } from "../ChatSearchBar";
import { FindProvider } from "./FindProvider";
import { isFindSurfaceVisible } from "../../lib/find/findVisibility";

function FindHarness() {
  const [extra, setExtra] = useState(false);
  return (
    <FindProvider>
      <main data-find-application-root>
        <p>Alpha in the first open document.</p>
        <section>
          <span>Second </span>
          <strong>alpha</strong>
          <span> spans ordinary rendered content.</span>
        </section>
        <details>
          <summary>Closed details</summary>
          <p>alpha must remain excluded</p>
        </details>
        <p hidden>alpha must remain hidden</p>
        {extra ? <p>Live alpha result.</p> : null}
        <button data-find-exclude type="button" onClick={() => setExtra(true)}>
          Add live result
        </button>
        <ChatSearchBar open onOpenChange={() => {}} />
      </main>
    </FindProvider>
  );
}

describe("application find", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    CSS.highlights?.clear();
  });

  it("counts only visible open content, wraps navigation, and updates live", async () => {
    await render(
      <StrictMode>
        <FindHarness />
      </StrictMode>,
    );
    const input = page.getByRole("searchbox", { name: "Find text" });
    await input.fill("alpha");

    await expect.element(page.getByText("1 / 2 results")).toBeVisible();
    expect(CSS.highlights?.get("penkra-find-match")?.size).toBe(2);

    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("2 / 2 results")).toBeVisible();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("1 / 2 results")).toBeVisible();
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await expect.element(page.getByText("2 / 2 results")).toBeVisible();

    await page.getByRole("button", { name: "Add live result" }).click();
    await expect.element(page.getByText("2 / 3 results")).toBeVisible();
    expect(CSS.highlights?.get("penkra-find-match")?.size).toBe(3);
  });

  it("excludes mounted surfaces owned by inactive panes", async () => {
    await render(
      <div aria-hidden="true" inert>
        <div data-testid="inactive-surface">Hidden mounted pane</div>
      </div>,
    );
    const surface = document.querySelector<HTMLElement>("[data-testid='inactive-surface']");
    expect(isFindSurfaceVisible(surface)).toBe(false);
  });

  it("searches transcript rows inside a display-contents wrapper", async () => {
    await render(
      <div style={{ display: "contents" }} data-testid="timeline">
        <article data-find-row-id="message-1">Visible transcript text</article>
      </div>,
    );
    const timeline = document.querySelector<HTMLElement>("[data-testid='timeline']");
    expect(timeline?.getClientRects().length).toBe(0);
    expect(
      isFindSurfaceVisible(timeline?.querySelector<HTMLElement>("[data-find-row-id]") ?? null),
    ).toBe(true);
  });
});
