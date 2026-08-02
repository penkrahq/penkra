// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { createAppBar } from "./appBar";
import { createIcon } from "./icons";

describe("framework-neutral App Bar", () => {
  it("renders ordered slots and preserves input semantics", () => {
    const activate = vi.fn();
    const change = vi.fn();
    const submit = vi.fn();
    const bar = createAppBar({
      leading: [
        { key: "back", label: "Back", icon: () => createIcon("back"), onActivate: activate },
      ],
      center: {
        kind: "input",
        value: "https://penkra.com",
        label: "Address",
        onValueChange: change,
        onSubmit: submit,
      },
      trailing: [],
    });
    const button = bar.element.querySelector<HTMLButtonElement>("[data-action='back']")!;
    const input = bar.element.querySelector<HTMLInputElement>("input")!;
    button.click();
    input.value = "https://example.com";
    input.dispatchEvent(new Event("input"));
    input.form!.dispatchEvent(new SubmitEvent("submit"));

    expect(activate).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledWith("https://example.com");
    expect(submit).toHaveBeenCalledWith("https://example.com");
    expect(bar.element.children).toHaveLength(3);
  });

  it("updates without retaining handlers from the previous composition", () => {
    const previous = vi.fn();
    const next = vi.fn();
    const bar = createAppBar({
      leading: [
        { key: "back", label: "Back", icon: () => createIcon("back"), onActivate: previous },
      ],
    });
    const removed = bar.element.querySelector<HTMLButtonElement>("button")!;
    bar.update({
      trailing: [
        { key: "close", label: "Close", icon: () => createIcon("close"), onActivate: next },
      ],
    });
    removed.click();
    bar.element.querySelector<HTMLButtonElement>("button")!.click();
    expect(previous).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
