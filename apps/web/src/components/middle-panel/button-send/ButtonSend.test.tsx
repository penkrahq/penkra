import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ButtonSend } from "./ButtonSend";

it("shows a disabled Stopping… button while awaiting provider confirmation", () => {
  const html = renderToStaticMarkup(<ButtonSend type="button" visualState="stopping" />);
  expect(html).toContain("Stopping…");
  expect(html).toContain('aria-label="Stopping…"');
  expect(html).toContain('disabled=""');
});
