// FILE: terminalFontSettle.ts
// Purpose: Signal configured font load completion; terminals fit immediately and refit when it settles.
// Layer: Terminal runtime utility
// Exports: waitForTerminalFontReady
// Depends on: Browser FontFaceSet API

// The first fit is independent; a settled font load triggers the later refit.
export async function waitForTerminalFontReady(input: {
  fontFamily: string;
  fontSize: number;
}): Promise<void> {
  if (typeof document === "undefined") return;
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts || typeof fonts.load !== "function") return;

  const fontFamily = input.fontFamily.trim();
  if (!fontFamily) return;

  try {
    await fonts.load(`${input.fontSize}px ${fontFamily}`);
  } catch {
    // Refit anyway; a bad font spec should not permanently strand terminal dimensions.
  }
}
