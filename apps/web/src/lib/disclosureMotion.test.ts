import { describe, expect, it } from "vitest";

import {
  disclosureChevronClassName,
  disclosureContentClassName,
  disclosureShellClassName,
  DISCLOSURE_CHEVRON_MOTION_CLASS,
  DISCLOSURE_COLLAPSIBLE_PANEL_CLASS,
  DISCLOSURE_INTRINSIC_SIZE_STYLE,
  DISCLOSURE_SHELL_MOTION_CLASS,
  DISCLOSURE_SHELL_CLOSED_CLASS,
  DISCLOSURE_SHELL_OPEN_CLASS,
} from "./disclosureMotion";

describe("disclosureMotion", () => {
  it("maps open state to the shared shell classes", () => {
    expect(disclosureShellClassName(true)).toContain(DISCLOSURE_SHELL_OPEN_CLASS);
    expect(disclosureShellClassName(false)).toContain(DISCLOSURE_SHELL_CLOSED_CLASS);
  });

  it("rotates the chevron when open", () => {
    expect(disclosureChevronClassName(true)).toContain("rotate-90");
    expect(disclosureChevronClassName(false)).not.toContain("rotate-90");
  });

  it("disables interaction on closed content", () => {
    expect(disclosureContentClassName(false)).toContain("pointer-events-none");
    expect(disclosureContentClassName(true)).not.toContain("pointer-events-none");
  });

  it("uses native intrinsic sizing and the productive expansion motion token", () => {
    expect(DISCLOSURE_INTRINSIC_SIZE_STYLE).toMatchObject({ interpolateSize: "allow-keywords" });
    expect(DISCLOSURE_SHELL_MOTION_CLASS).toContain("transition-[height]");
    expect(DISCLOSURE_SHELL_MOTION_CLASS).not.toContain("grid-template-rows");

    for (const className of [
      DISCLOSURE_SHELL_MOTION_CLASS,
      DISCLOSURE_CHEVRON_MOTION_CLASS,
      DISCLOSURE_COLLAPSIBLE_PANEL_CLASS,
    ]) {
      expect(className).toContain("duration-150");
      expect(className).toContain("[transition-timing-function:ease]");
      expect(className).toContain("motion-reduce:transition-none");
    }
  });
});
