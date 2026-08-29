// FILE: appPackageRevision.ts
// Purpose: Defines the verified package identity used for document URLs and HTTP cache validation.
// Layer: Trusted desktop App runtime

export const APP_PACKAGE_REVISION_QUERY_PARAMETER = "penkra-package";

const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;

export function normalizeAppPackageRevision(sha256: string): string {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new TypeError("App package revision must be a SHA-256 digest.");
  }
  return sha256.toLowerCase();
}

export function appPackageEntityTag(sha256: string): string {
  return `"penkra-package-${normalizeAppPackageRevision(sha256)}"`;
}

export function addAppPackageRevisionToDocumentUrl(documentUrl: string, sha256: string): string {
  const url = new URL(documentUrl);
  url.searchParams.set(APP_PACKAGE_REVISION_QUERY_PARAMETER, normalizeAppPackageRevision(sha256));
  return url.href;
}

export function requestAcceptsAppPackageEntityTag(
  ifNoneMatch: string | null,
  entityTag: string,
): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//u, "");
    return normalized === "*" || normalized === entityTag;
  });
}
