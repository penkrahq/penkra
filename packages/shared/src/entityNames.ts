// User-visible entity names compare canonically so the client and server agree
// about collisions across case and equivalent Unicode representations.
export function normalizeEntityName(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}
