export function resolveHttpByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Unsupported units, malformed ranges and multipart requests may be ignored.
  if (!match || (!match[1] && !match[2])) return null;
  if (size === 0) return "unsatisfiable";
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  )
    return "unsatisfiable";
  if (first === null) {
    if (!last) return "unsatisfiable";
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== null && last < first)) return "unsatisfiable";
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}
