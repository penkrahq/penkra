import type { AppContextMenuItem } from "@penkra/sdk";

export type NormalizedAppContextMenuAction = {
  type: "action";
  id: string;
  label: string;
  enabled: boolean;
  checked: boolean | undefined;
  accelerator: string | undefined;
  destructive: boolean;
};

export type NormalizedAppContextMenuItem =
  | NormalizedAppContextMenuAction
  | { type: "separator" }
  | {
      type: "submenu";
      label: string;
      enabled: boolean;
      items: NormalizedAppContextMenuItem[];
    };

const MAX_DEPTH = 8;
const MAX_ITEMS = 500;

export function normalizeAppContextMenuItems(input: unknown): NormalizedAppContextMenuItem[] {
  if (!Array.isArray(input)) throw new Error("Context menu items must be an array.");
  const ids = new Set<string>();
  let itemCount = 0;

  const normalize = (items: readonly unknown[], depth: number): NormalizedAppContextMenuItem[] => {
    if (depth > MAX_DEPTH) throw new Error("Context menu nesting is too deep.");
    const output: NormalizedAppContextMenuItem[] = [];
    for (const candidate of items) {
      itemCount += 1;
      if (itemCount > MAX_ITEMS) throw new Error("Context menu has too many items.");
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("Each context menu item must be an object.");
      }
      const item = candidate as Record<string, unknown>;
      if (item.separatorBefore === true && output.length > 0) output.push({ type: "separator" });
      if (item.type === "separator") {
        if (output.length > 0 && output.at(-1)?.type !== "separator") {
          output.push({ type: "separator" });
        }
        continue;
      }
      if (item.type === "submenu") {
        const label = requireLabel(item.label);
        if (!Array.isArray(item.items)) throw new Error("A context submenu needs an items array.");
        const children = normalize(item.items, depth + 1);
        if (!children.some((child) => child.type !== "separator")) continue;
        output.push({
          type: "submenu",
          label,
          enabled: optionalBoolean(item.enabled, true),
          items: children,
        });
        continue;
      }
      if (item.type !== undefined && item.type !== "action") {
        throw new Error("Unknown context menu item type.");
      }
      if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 255) {
        throw new Error("A context menu action needs a bounded non-empty id.");
      }
      if (ids.has(item.id)) throw new Error("Context menu action ids must be unique.");
      ids.add(item.id);
      const accelerator = optionalString(item.accelerator, "accelerator");
      output.push({
        type: "action",
        id: item.id,
        label: requireLabel(item.label),
        enabled: optionalBoolean(item.enabled, true),
        checked: item.checked === undefined ? undefined : optionalBoolean(item.checked, false),
        accelerator,
        destructive: optionalBoolean(item.destructive, false),
      });
    }
    while (output.at(-1)?.type === "separator") output.pop();
    return output;
  };

  return normalize(input satisfies ReadonlyArray<AppContextMenuItem>, 1);
}

function requireLabel(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 255) {
    throw new Error("A context menu label must be a bounded non-empty string.");
  }
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("Context menu boolean fields must be boolean.");
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    throw new Error(`Context menu ${name} must be a bounded non-empty string.`);
  }
  return value;
}
