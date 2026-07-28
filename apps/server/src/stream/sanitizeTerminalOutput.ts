// Terminal output is the one place where matching control bytes is intentional:
// they are protocol framing to remove, not user-visible text.
// eslint-disable-next-line no-control-regex
const ANSI_OSC_SEQUENCE = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
// eslint-disable-next-line no-control-regex
const ANSI_CSI_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ANSI_SINGLE_CHARACTER_SEQUENCE = /\u001B[@-_]/g;
// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g;

/**
 * Convert interactive terminal output into safe, readable text for the UI.
 * Carriage-return progress updates become lines so their final diagnostics
 * remain visible, while terminal control sequences are removed completely.
 */
export function sanitizeTerminalOutput(output: string): string {
  return output
    .replace(ANSI_OSC_SEQUENCE, "")
    .replace(ANSI_CSI_SEQUENCE, "")
    .replace(ANSI_SINGLE_CHARACTER_SEQUENCE, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(UNSAFE_CONTROL_CHARACTER, "")
    .trim();
}
