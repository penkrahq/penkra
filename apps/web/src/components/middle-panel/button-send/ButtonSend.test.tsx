import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ButtonSend } from "./ButtonSend";

it("shows a disabled spinner with a screen-reader stopping label while awaiting provider confirmation", () => {
  const html = renderToStaticMarkup(<ButtonSend type="button" visualState="stopping" />);
  expect(html).not.toContain(">Stopping…<");
  expect(html).toContain("animate-spin");
  expect(html).not.toContain("w-auto");
  expect(html).toContain('aria-label="Stopping…"');
  expect(html).toContain('disabled=""');
});
