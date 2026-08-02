export interface AppBarAction {
  key: string;
  label: string;
  icon: Node | (() => Node);
  onActivate: () => void;
  disabled?: boolean;
  pressed?: boolean;
}

export type AppBarCenter =
  | { kind: "display"; text?: string; icon?: Node | (() => Node) }
  | {
      kind: "input";
      value: string;
      placeholder?: string;
      icon?: Node | (() => Node);
      label: string;
      onValueChange: (value: string) => void;
      onSubmit?: (value: string) => void;
    }
  | { kind: "custom"; content: Node | (() => Node) };

export interface AppBarOptions {
  label?: string;
  leading?: readonly AppBarAction[];
  center?: AppBarCenter;
  trailing?: readonly AppBarAction[];
}

export interface AppBar {
  readonly element: HTMLElement;
  update(options: AppBarOptions): void;
  destroy(): void;
}

export function createAppBar(initial: AppBarOptions): AppBar {
  const element = document.createElement("header");
  element.className = "penkra-app-bar";
  let cleanups: Array<() => void> = [];

  const update = (options: AppBarOptions): void => {
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    element.replaceChildren();
    element.setAttribute("aria-label", options.label ?? "App navigation");

    element.append(
      actionGroup("leading", options.leading ?? [], cleanups),
      centerSlot(options.center, cleanups),
      actionGroup("trailing", options.trailing ?? [], cleanups),
    );
  };

  update(initial);
  return {
    element,
    update,
    destroy: () => {
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
      element.remove();
    },
  };
}

function actionGroup(
  slot: "leading" | "trailing",
  actions: readonly AppBarAction[],
  cleanups: Array<() => void>,
): HTMLElement {
  const group = document.createElement("div");
  group.className = `penkra-app-bar__${slot}`;
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "penkra-app-bar__action";
    button.dataset.action = action.key;
    button.setAttribute("aria-label", action.label);
    button.disabled = action.disabled === true;
    if (action.pressed !== undefined) button.setAttribute("aria-pressed", String(action.pressed));
    button.append(materialize(action.icon));
    button.addEventListener("click", action.onActivate);
    cleanups.push(() => button.removeEventListener("click", action.onActivate));
    group.append(button);
  }
  return group;
}

function centerSlot(center: AppBarCenter | undefined, cleanups: Array<() => void>): HTMLElement {
  const slot = document.createElement("div");
  slot.className = "penkra-app-bar__center";
  if (!center) return slot;
  if (center.kind === "custom") {
    slot.append(materialize(center.content));
    return slot;
  }
  if (center.kind === "display") {
    slot.classList.add("penkra-app-bar__display");
    if (center.icon) slot.append(materialize(center.icon));
    if (center.text !== undefined) slot.append(document.createTextNode(center.text));
    return slot;
  }

  const form = document.createElement("form");
  form.className = "penkra-app-bar__input";
  if (center.icon) form.append(materialize(center.icon));
  const input = document.createElement("input");
  input.value = center.value;
  input.placeholder = center.placeholder ?? "";
  input.setAttribute("aria-label", center.label);
  const onInput = (): void => center.onValueChange(input.value);
  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    center.onSubmit?.(input.value);
  };
  input.addEventListener("input", onInput);
  form.addEventListener("submit", onSubmit);
  cleanups.push(() => input.removeEventListener("input", onInput));
  cleanups.push(() => form.removeEventListener("submit", onSubmit));
  form.append(input);
  slot.append(form);
  return slot;
}

function materialize(value: Node | (() => Node)): Node {
  return typeof value === "function" ? value() : value.cloneNode(true);
}
