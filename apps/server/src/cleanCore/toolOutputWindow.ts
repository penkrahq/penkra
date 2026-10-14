import { INLINE_TOOL_RESULT_BYTES } from "@penkra/shared/toolResults";

export type RawOutputWindow =
  | { readonly output: string; readonly bytes: number; readonly truncated?: false }
  | {
      readonly output: string;
      readonly bytes: number;
      readonly truncated: true;
      readonly headLength: number;
      readonly tailLength: number;
    };

// A UTF-8 cut must not leave half of a code point at either edge.
function prefix(text: string, budget: number): string {
  const bytes = Buffer.from(text, "utf8");
  let end = Math.min(bytes.length, budget);
  while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function suffix(text: string, budget: number): string {
  const bytes = Buffer.from(text, "utf8");
  let start = Math.max(0, bytes.length - budget);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

/** Display-only first/last output window; the provider owns its native tool result. */
export function appendToolOutputWindow(
  current: RawOutputWindow | null,
  delta: string,
): RawOutputWindow {
  const bytes = (current?.bytes ?? 0) + Buffer.byteLength(delta, "utf8");
  if (!current?.truncated && bytes <= INLINE_TOOL_RESULT_BYTES)
    return { output: (current?.output ?? "") + delta, bytes };

  const half = INLINE_TOOL_RESULT_BYTES / 2;
  const head = current?.truncated
    ? current.output.slice(0, current.headLength)
    : prefix((current?.output ?? "") + delta, half);
  const previousTail = current?.truncated
    ? current.output.slice(current.output.length - current.tailLength)
    : (current?.output ?? "");
  const tail = suffix(previousTail + delta, half);
  const omittedBytes = bytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  return {
    output: `${head}\n… ${omittedBytes} bytes omitted …\n${tail}`,
    bytes,
    truncated: true,
    headLength: head.length,
    tailLength: tail.length,
  };
}
