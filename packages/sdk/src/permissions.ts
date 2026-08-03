import type { AppPermissionDeclaration } from "./manifest";

export const PENKRA_PERMISSIONS = {
  "network-fetch": {
    name: "network-fetch",
    summary: "Make attributed requests through Penkra's mediated HTTP API.",
    risk: "standard",
  },
  "raw-socket": {
    name: "raw-socket",
    summary: "Open reviewed non-HTTP network connections outside ordinary web fetch policy.",
    risk: "high",
  },
  "process-spawn": {
    name: "process-spawn",
    summary: "Launch a reviewed executable without implicit shell interpolation.",
    risk: "high",
  },
  "browser-session": {
    name: "browser-session",
    summary: "Create and control isolated web pages through Penkra's hosted browser service.",
    risk: "high",
  },
} as const;

export type PenkraPermissionName = keyof typeof PENKRA_PERMISSIONS;

export type AppPermissionDeclarationChange =
  | { kind: "added"; permission: AppPermissionDeclaration }
  | { kind: "removed"; permission: AppPermissionDeclaration }
  | {
      kind: "requirement-changed";
      before: AppPermissionDeclaration;
      after: AppPermissionDeclaration;
    }
  | { kind: "reason-changed"; before: AppPermissionDeclaration; after: AppPermissionDeclaration };

export function isPenkraPermissionName(value: string): value is PenkraPermissionName {
  return Object.hasOwn(PENKRA_PERMISSIONS, value);
}

export function diffAppPermissionDeclarations(
  before: readonly AppPermissionDeclaration[],
  after: readonly AppPermissionDeclaration[],
): AppPermissionDeclarationChange[] {
  const previous = new Map(before.map((permission) => [permission.name, permission]));
  const next = new Set(after.map((permission) => permission.name));
  const changes: AppPermissionDeclarationChange[] = [];
  for (const permission of after) {
    const existing = previous.get(permission.name);
    if (!existing) {
      changes.push({ kind: "added", permission });
      continue;
    }
    if (existing.required !== permission.required) {
      changes.push({ kind: "requirement-changed", before: existing, after: permission });
    }
    if (existing.reason !== permission.reason) {
      changes.push({ kind: "reason-changed", before: existing, after: permission });
    }
  }
  for (const permission of before) {
    if (!next.has(permission.name)) changes.push({ kind: "removed", permission });
  }
  return changes;
}

export function permissionsRequiringUpdateReview(
  before: readonly AppPermissionDeclaration[],
  after: readonly AppPermissionDeclaration[],
): PenkraPermissionName[] {
  return diffAppPermissionDeclarations(before, after).flatMap((change) => {
    if (change.kind === "added")
      return isPenkraPermissionName(change.permission.name) ? [change.permission.name] : [];
    if (change.kind === "requirement-changed" && change.after.required) {
      return isPenkraPermissionName(change.after.name) ? [change.after.name] : [];
    }
    return [];
  });
}
