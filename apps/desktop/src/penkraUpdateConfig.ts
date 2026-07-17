// The release build replaces this identifier through tsdown. Development and
// ordinary test builds intentionally have no update credential.
declare const __PENKRA_UPDATE_TOKEN__: string;

export function bakedPenkraUpdateToken(): string {
  return typeof __PENKRA_UPDATE_TOKEN__ === "string" ? __PENKRA_UPDATE_TOKEN__.trim() : "";
}

export function penkraUpdateRequestHeaders(token: string): Record<string, string> {
  const normalized = token.trim();
  return normalized ? { "X-Penkra-Update-Token": normalized } : {};
}
