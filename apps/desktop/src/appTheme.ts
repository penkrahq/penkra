// FILE: appTheme.ts
// Purpose: Validates shell-owned Theme tokens and renders the isolated App CSS contract.
// Layer: Trusted desktop App runtime

import type { DesktopAppTheme, DesktopAppTypography } from "@penkra/contracts";

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

const TYPOGRAPHY_CSS_NAMES = {
  base: "--penkra-font-size-base",
  small: "--penkra-font-size-small",
  meta: "--penkra-font-size-meta",
  large: "--penkra-font-size-large",
} as const satisfies Record<keyof DesktopAppTypography, string>;

export function parseDesktopAppTypography(value: unknown): DesktopAppTypography {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("App Typography must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const names = Object.keys(TYPOGRAPHY_CSS_NAMES) as Array<keyof DesktopAppTypography>;
  if (
    Object.keys(candidate).length !== names.length ||
    names.some((name) => !(name in candidate))
  ) {
    throw new Error("App Typography must provide the complete semantic token contract.");
  }
  const result = {} as Record<keyof DesktopAppTypography, string>;
  for (const name of names) {
    const token = candidate[name];
    if (typeof token !== "string" || !/^\d+(?:\.\d+)?px$/u.test(token)) {
      throw new Error(`App Typography token ${name} is invalid.`);
    }
    const pixels = Number.parseFloat(token);
    if (pixels < 8 || pixels > 24) {
      throw new Error(`App Typography token ${name} is outside the supported range.`);
    }
    result[name] = token;
  }
  return result;
}

export function renderDesktopAppTypographyCss(typography: DesktopAppTypography): string {
  const declarations = (Object.keys(TYPOGRAPHY_CSS_NAMES) as Array<keyof DesktopAppTypography>)
    .map((name) => `${TYPOGRAPHY_CSS_NAMES[name]}:${typography[name]}`)
    .join(";");
  return `:root{${declarations}}`;
}
