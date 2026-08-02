export const PENKRA_ICON_NAMES = ["back", "close", "forward", "more", "search"] as const;
export type PenkraIconName = (typeof PENKRA_ICON_NAMES)[number];

const ICON_PATHS: Record<PenkraIconName, string> = {
  back: "M15 18l-6-6 6-6",
  close: "M6 6l12 12M18 6 6 18",
  forward: "m9 18 6-6-6-6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  search: "m21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
};

export function createIcon(name: PenkraIconName, label?: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICON_PATHS[name]);
  svg.append(path);
  return svg;
}
