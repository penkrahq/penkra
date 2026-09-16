import type { ContextMenuItem } from "@penkra/contracts";

export interface ContextMenuItemWithIcon<T extends string = string> extends ContextMenuItem<T> {
  icon?: string; // SVG string
}

/**
 * Imperative DOM-based context menu that matches the app's Base UI menu styling.
 * Shows a positioned dropdown and returns a promise that resolves
 * with the clicked item id, or null if dismissed.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItemWithIcon<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999";

    const menu = document.createElement("div");
    menu.className =
      "fixed z-[10000] min-w-[180px] rounded-xl border border-white/[0.08] shadow-xl animate-in fade-in zoom-in-95";

    const x = position?.x ?? 0;
    const y = position?.y ?? 0;
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;
    menu.style.backgroundColor = `color-mix(in srgb, var(--popover) 90%, transparent)`;
    menu.style.backdropFilter = "blur(24px)";
    (menu.style as any).webkitBackdropFilter = "blur(24px)";

    const inner = document.createElement("div");
    inner.className = "p-1";
    menu.appendChild(inner);

    let focusedIndex = -1;
    const buttons: HTMLButtonElement[] = [];

    function cleanup(result: T | null) {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      menu.remove();
      resolve(result);
    }

    function focusItem(index: number) {
      if (index < 0 || index >= buttons.length || buttons[index]?.disabled) return;
      buttons[focusedIndex]?.classList.remove("bg-[var(--sidebar-accent)]");
      focusedIndex = index;
      buttons[focusedIndex]?.classList.add("bg-[var(--sidebar-accent)]");
      buttons[focusedIndex]?.focus();
    }

    function nextEnabledIndex(direction: 1 | -1): number {
      if (buttons.length === 0) return -1;
      const start = focusedIndex < 0 ? (direction === 1 ? -1 : 0) : focusedIndex;
      for (let offset = 1; offset <= buttons.length; offset += 1) {
        const index = (start + direction * offset + buttons.length) % buttons.length;
        if (!buttons[index]?.disabled) return index;
      }
      return -1;
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(null);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        focusItem(nextEnabledIndex(1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusItem(nextEnabledIndex(-1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (
          focusedIndex >= 0 &&
          focusedIndex < items.length &&
          buttons[focusedIndex]?.disabled !== true
        ) {
          cleanup(items[focusedIndex]!.id);
        }
      }
    }

    overlay.addEventListener("mousedown", () => cleanup(null));
    document.addEventListener("keydown", onKeyDown);

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const isDestructive = item.destructive === true || item.id === "delete";

      // Keep explicit groups visible in the browser fallback; destructive items remain isolated by default.
      if ((item.separatorBefore === true || isDestructive) && i > 0) {
        const sep = document.createElement("div");
        sep.className = "mx-2.5 my-1 h-px bg-border";
        inner.appendChild(sep);
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = isDestructive
        ? "flex w-full min-h-7 cursor-default select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[length:var(--app-font-size-ui,12px)] text-foreground/86 transition-colors"
        : "flex w-full min-h-7 cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[length:var(--app-font-size-ui,12px)] text-foreground/86 transition-colors";
      btn.disabled = item.enabled === false;
      if (btn.disabled) btn.classList.add("opacity-40");

      if (item.icon) {
        const iconWrapper = document.createElement("span");
        iconWrapper.className = "size-4 flex items-center justify-center opacity-60";
        iconWrapper.innerHTML = item.icon;
        btn.appendChild(iconWrapper);
      }

      const label = document.createElement("span");
      label.textContent = item.label;
      btn.appendChild(label);

      if (!btn.disabled) btn.addEventListener("click", () => cleanup(item.id));
      btn.addEventListener("mouseenter", () => focusItem(buttons.indexOf(btn)));
      btn.addEventListener("mouseleave", () => {
        btn.classList.remove("bg-[var(--sidebar-accent)]");
        focusedIndex = -1;
      });
      buttons.push(btn);
      inner.appendChild(btn);
    }

    document.body.appendChild(overlay);
    document.body.appendChild(menu);

    // Adjust if menu overflows viewport
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width - 4}px`;
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height - 4}px`;
      }
    });
  });
}
