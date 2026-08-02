// FILE: appTheme.ts
// Purpose: Validates shell-owned Theme tokens and renders the isolated App CSS contract.
// Layer: Trusted desktop App runtime

import type { DesktopAppTheme } from "@penkra/contracts";

const TOKEN_NAMES = [
  "background",
  "panel",
  "surface",
  "control",
  "selected",
  "overlay",
  "textPrimary",
  "textSecondary",
  "textMuted",
  "border",
  "focus",
  "accent",
  "success",
  "warning",
  "destructive",
  "info",
  "fontSans",
] as const satisfies ReadonlyArray<keyof DesktopAppTheme["tokens"]>;

const CSS_NAMES: Record<(typeof TOKEN_NAMES)[number], string> = {
  background: "--penkra-color-background",
  panel: "--penkra-color-panel",
  surface: "--penkra-color-surface",
  control: "--penkra-color-control",
  selected: "--penkra-color-selected",
  overlay: "--penkra-color-overlay",
  textPrimary: "--penkra-color-text-primary",
  textSecondary: "--penkra-color-text-secondary",
  textMuted: "--penkra-color-text-muted",
  border: "--penkra-color-border",
  focus: "--penkra-color-focus",
  accent: "--penkra-color-accent",
  success: "--penkra-color-success",
  warning: "--penkra-color-warning",
  destructive: "--penkra-color-destructive",
  info: "--penkra-color-info",
  fontSans: "--penkra-font-sans",
};

export function parseDesktopAppTheme(value: unknown): DesktopAppTheme {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("App Theme must be an object.");
  const candidate = value as Record<string, unknown>;
  if (candidate.variant !== "light" && candidate.variant !== "dark")
    throw new Error("App Theme variant must be light or dark.");
  if (!candidate.tokens || typeof candidate.tokens !== "object" || Array.isArray(candidate.tokens))
    throw new Error("App Theme tokens must be an object.");
  const tokens = candidate.tokens as Record<string, unknown>;
  if (
    Object.keys(tokens).length !== TOKEN_NAMES.length ||
    TOKEN_NAMES.some((name) => !(name in tokens))
  ) {
    throw new Error("App Theme must provide the complete semantic token contract.");
  }
  const result: Record<string, string> = {};
  for (const name of TOKEN_NAMES) {
    const token = tokens[name];
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > 512 ||
      /[;{}]/u.test(token)
    ) {
      throw new Error(`App Theme token ${name} is invalid.`);
    }
    result[name] = token;
  }
  return { variant: candidate.variant, tokens: result as unknown as DesktopAppTheme["tokens"] };
}

export function renderDesktopAppThemeCss(theme: DesktopAppTheme): string {
  const declarations = TOKEN_NAMES.map((name) => `${CSS_NAMES[name]}:${theme.tokens[name]}`).join(
    ";",
  );
  return `:root{color-scheme:${theme.variant};${declarations}}`;
}
