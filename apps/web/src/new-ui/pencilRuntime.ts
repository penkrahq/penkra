export type Phase =
  | "welcome"
  | "agents"
  | "connections"
  | "api-key"
  | "apps"
  | "workspace"
  | "apps-panel"
  | "permission"
  | "settings"
  | "settings-permissions"
  | "settings-agents"
  | "settings-apps"
  | "settings-connectors"
  | "settings-appearance"
  | "settings-account";

export interface RuntimeCallbacks {
  go(phase: Phase): void;
}

interface MockState {
  agents: string[];
  apps: Record<string, boolean>;
  apiKey: string;
  keyName: string;
  composerDraft: string;
  messages: string[];
  selectedThread: string;
  appearance: string;
  harness: string;
  model: string;
  toggles: Record<string, boolean>;
}

const STORAGE_KEY = "penkra-mock-state-v2";
const PRIMARY = {
  default: "#3B82F6",
  hover: "#5B9CF6",
  active: "#2563EB",
  disabled: "#1F212B",
};
const PRIMARY_TEXT = { enabled: "#FFFFFF", disabled: "#4A4E5E" };
const OUTLINE = {
  default: "#00000000",
  hover: "#FFFFFF0D",
  active: "#1F212B",
};
const ROW = {
  default: "#00000000",
  hover: "#FFFFFF0D",
  active: "#1F212B",
};
const CARD = {
  defaultBackground: "#141519",
  activeBackground: "#1F212B",
  defaultBorder: "#26272E",
  hoverBorder: "#5B5F73",
  activeBorder: "#4A4E5E",
};

const defaults: MockState = {
  agents: ["Claude"],
  apps: {
    Slack: true,
    Notion: true,
    Browser: true,
    Blender: false,
    "Microsoft Excel": false,
    "Microsoft Word": false,
    Ledger: true,
  },
  apiKey: "",
  keyName: "",
  composerDraft: "",
  messages: [],
  selectedThread: "Main",
  appearance: "System",
  harness: "Claude",
  model: "Claude Sonnet 5",
  toggles: {},
};

function loadState(): MockState {
  try {
    return { ...defaults, ...JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return { ...defaults };
  }
}

const state = loadState();

function saveState() {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function all(document: Document, name: string) {
  return [...document.querySelectorAll<HTMLElement>(`[data-pencil-name="${name}"]`)];
}

function first(document: Document, name: string) {
  return document.querySelector<HTMLElement>(`[data-pencil-name="${name}"]`);
}

function descendants(element: HTMLElement) {
  return [element, ...element.querySelectorAll<HTMLElement>("*")];
}

function setForeground(element: HTMLElement, color: string) {
  const semanticNames = new Set([
    "Chevron",
    "Chevron Icon",
    "Dots",
    "Icon",
    "Label",
    "Leading Icon",
    "More",
    "Name",
    "Text",
    "Title",
    "Trailing",
  ]);
  const candidates = descendants(element).filter((node) => {
    if (node === element) return true;
    return semanticNames.has(node.dataset.pencilName ?? "");
  });
  for (const node of candidates) {
    if (node.style.color) node.style.color = color;
    for (const path of node.querySelectorAll<SVGElement>("path")) {
      if (path.getAttribute("fill") && path.getAttribute("fill") !== "none") {
        path.setAttribute("fill", color);
      }
      if (path.getAttribute("stroke") && path.getAttribute("stroke") !== "none") {
        path.setAttribute("stroke", color);
      }
    }
  }
}

function makeKeyboardClickable(element: HTMLElement) {
  element.tabIndex = 0;
  element.setAttribute("role", "button");
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    element.click();
  });
}

function onClick(element: HTMLElement | null, action: (event: MouseEvent) => void) {
  if (!element) return;
  element.style.cursor = "pointer";
  makeKeyboardClickable(element);
  element.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    action(event);
  });
}

function bindName(document: Document, name: string, action: (event: MouseEvent) => void) {
  for (const element of all(document, name)) onClick(element, action);
}

function isPrimaryButton(element: HTMLElement) {
  return getComputedStyle(element).backgroundColor === "rgb(59, 130, 246)";
}

function paintButton(
  element: HTMLElement,
  mode: keyof typeof PRIMARY | "outline-default" | "outline-hover" | "outline-active",
) {
  const primary = isPrimaryButton(element) || element.dataset.penkraPrimary === "true";
  if (primary) {
    element.dataset.penkraPrimary = "true";
    const disabled = mode === "disabled";
    const primaryMode: keyof typeof PRIMARY =
      mode === "hover" || mode === "active" || mode === "disabled" ? mode : "default";
    element.style.backgroundColor = PRIMARY[primaryMode];
    setForeground(element, disabled ? PRIMARY_TEXT.disabled : PRIMARY_TEXT.enabled);
    return;
  }

  const outlineMode = mode.startsWith("outline")
    ? mode.replace("outline-", "")
    : mode === "hover"
      ? "hover"
      : mode === "active"
        ? "active"
        : "default";
  element.style.backgroundColor = OUTLINE[outlineMode as keyof typeof OUTLINE];
  setForeground(element, outlineMode === "default" ? "#9AA0B4" : "#E8EAF2");
}

function installButtonStates(document: Document) {
  const selector = [
    '[data-pencil-name$="Button"]',
    '[data-pencil-name="Skip Button"]',
    '[data-pencil-name="Back Button"]',
  ].join(",");

  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    element.style.cursor = element.getAttribute("aria-disabled") === "true" ? "default" : "pointer";
    makeKeyboardClickable(element);
    const back = element.dataset.pencilName === "Back Button";

    element.addEventListener("pointerenter", () => {
      if (element.getAttribute("aria-disabled") === "true") return;
      if (back) setForeground(element, "#E8EAF2");
      else paintButton(element, "hover");
    });
    element.addEventListener("pointerdown", () => {
      if (element.getAttribute("aria-disabled") === "true") return;
      if (back) setForeground(element, "#E8EAF2");
      else paintButton(element, "active");
    });
    const restore = () => {
      if (element.getAttribute("aria-disabled") === "true") {
        if (back) setForeground(element, "#4A4E5E");
        else paintButton(element, "disabled");
      } else if (back) {
        setForeground(element, "#9AA0B4");
      } else {
        paintButton(
          element,
          element.dataset.penkraPrimary === "true" ? "default" : "outline-default",
        );
      }
    };
    element.addEventListener("pointerup", restore);
    element.addEventListener("pointerleave", restore);
  }
}

function installRowStates(document: Document) {
  const names = ["Nav Item —", "Thread —", "Folder —", "Show more —"];
  const exact = new Set([
    "Account",
    "Workspace — penkra",
    "General Row",
    "Permissions Row",
    "Agents Row",
    "Apps Row",
    "Connectors Row",
    "Appearance Row",
    "Account Row",
    "Claude Agent",
    "Codex",
    "OpenCode",
    "Ledger",
    "Calendar",
    "Mail",
    "Notes",
    "Reminders",
  ]);

  for (const element of document.querySelectorAll<HTMLElement>("[data-pencil-name]")) {
    const name = element.dataset.pencilName ?? "";
    if (!names.some((prefix) => name.startsWith(prefix)) && !exact.has(name)) continue;
    const initiallySelected = getComputedStyle(element).backgroundColor === "rgb(31, 33, 43)";
    element.dataset.penkraSelected = String(initiallySelected);
    element.style.cursor = "pointer";
    element.addEventListener("pointerenter", () => {
      if (element.dataset.penkraSelected === "true") return;
      element.style.backgroundColor = ROW.hover;
      setForeground(element, "#E8EAF2");
      const trailing = element.querySelector<HTMLElement>('[data-pencil-name="Trailing"]');
      if (trailing) trailing.style.visibility = "visible";
    });
    element.addEventListener("pointerdown", () => {
      if (element.dataset.penkraSelected !== "true") element.style.backgroundColor = ROW.active;
    });
    element.addEventListener("pointerleave", () => {
      if (element.dataset.penkraSelected === "true") return;
      element.style.backgroundColor = ROW.default;
      setForeground(element, "#9AA0B4");
      const trailing = element.querySelector<HTMLElement>('[data-pencil-name="Trailing"]');
      if (trailing) trailing.style.visibility = "hidden";
    });
  }
}

function installTooltips(document: Document) {
  const labels: Record<string, string> = {
    Search: "Search",
    "Panel Icon": "Toggle panel",
    Copy: "Copy response",
    Edit: "Edit message",
    Retry: "Retry response",
    Attach: "Attach files",
    Mic: "Voice input",
    "Voice input": "Voice input",
    Sliders: "Settings",
    Help: "Help",
    "Refresh Icon": "Refresh",
    More: "More",
    Dots: "More",
  };

  let tooltip: HTMLElement | null = null;
  const hide = () => {
    tooltip?.remove();
    tooltip = null;
  };
  for (const [name, label] of Object.entries(labels)) {
    for (const trigger of all(document, name)) {
      trigger.addEventListener("pointerenter", () => {
        hide();
        const rect = trigger.getBoundingClientRect();
        tooltip = document.createElement("div");
        tooltip.textContent = label;
        tooltip.style.cssText = [
          "position:fixed",
          `left:${rect.left + rect.width / 2}px`,
          `top:${Math.max(8, rect.top - 8)}px`,
          "transform:translate(-50%,-100%)",
          "z-index:1000",
          "box-sizing:border-box",
          "border:1px solid #1A1A1A",
          "border-radius:8px",
          "background:#000000",
          "padding:6px 10px",
          "color:#E8EAF2",
          'font:500 11px -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif',
          "line-height:normal",
          "white-space:nowrap",
          "pointer-events:none",
        ].join(";");
        document.body.append(tooltip);
      });
      trigger.addEventListener("pointerleave", hide);
    }
  }
}

let activePopover: HTMLElement | null = null;

function closePopover() {
  activePopover?.remove();
  activePopover = null;
}

function paintPopupRows(root: HTMLElement) {
  for (const row of root.querySelectorAll<HTMLElement>(":scope > [data-pencil-name]")) {
    row.style.cursor = "pointer";
    row.addEventListener("pointerenter", () => {
      if (row.dataset.penkraSelected !== "true") row.style.backgroundColor = ROW.hover;
    });
    row.addEventListener("pointerleave", () => {
      if (row.dataset.penkraSelected !== "true") row.style.backgroundColor = ROW.default;
    });
  }
}

async function openExportPopover(
  document: Document,
  trigger: HTMLElement,
  file: string,
  align: "left" | "right" = "left",
) {
  const rect = trigger.getBoundingClientRect();
  closePopover();
  const response = await fetch(`./pencil/${file}`);
  const html = await response.text();
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const popover = parsed.body.firstElementChild?.cloneNode(true) as HTMLElement | undefined;
  if (!popover) return null;

  popover.style.position = "fixed";
  popover.style.left = align === "right" ? `${rect.right}px` : `${rect.left}px`;
  popover.style.top = `${rect.top - 8}px`;
  popover.style.transform = align === "right" ? "translate(-100%,-100%)" : "translate(0,-100%)";
  popover.style.zIndex = "900";
  popover.style.boxShadow = "0 12px 32px #00000066";
  document.body.append(popover);
  activePopover = popover;
  paintPopupRows(popover);

  setTimeout(() => {
    const dismiss = (event: PointerEvent) => {
      if (activePopover?.contains(event.target as Node)) return;
      closePopover();
      document.removeEventListener("pointerdown", dismiss);
    };
    document.addEventListener("pointerdown", dismiss);
  });
  return popover;
}

function installOverlayMenus(document: Document, phase: Phase, callbacks: RuntimeCallbacks) {
  if (phase === "workspace" || phase === "apps-panel") {
    const account = first(document, "Account");
    onClick(account, () => {
      if (!account) return;
      void openExportPopover(document, account, "account-menu.html").then((menu) => {
        if (!menu) return;
        onClick(menu.querySelector<HTMLElement>('[data-pencil-name="Settings"]'), () => {
          closePopover();
          callbacks.go("settings");
        });
        onClick(menu.querySelector<HTMLElement>('[data-pencil-name="Log Out"]'), () => {
          sessionStorage.removeItem(STORAGE_KEY);
          sessionStorage.removeItem("penkra-mock-phase");
          closePopover();
          callbacks.go("welcome");
        });
      });
    });

    bindName(document, "Sliders", () => callbacks.go("settings"));
    bindName(document, "Full Access", () => callbacks.go("settings-permissions"));

    const mode = first(document, "Mode");
    onClick(mode, () => {
      if (!mode) return;
      void openExportPopover(document, mode, "quick-settings.html", "right").then((quick) => {
        if (!quick) return;
        const model = quick.querySelector<HTMLElement>('[data-pencil-name="Model"]');
        onClick(model, () => {
          if (!model) return;
          void openExportPopover(document, model, "model-submenu.html", "right").then((models) => {
            if (!models) return;
            for (const choice of models.querySelectorAll<HTMLElement>(
              '[data-pencil-name^="Claude "]',
            )) {
              const name = choice.dataset.pencilName ?? "";
              const selected = name === state.model;
              choice.dataset.penkraSelected = String(selected);
              choice.style.backgroundColor = selected ? ROW.active : ROW.default;
              onClick(choice, () => {
                state.model = name;
                saveState();
                closePopover();
              });
            }
          });
        });
        const advanced = quick.querySelector<HTMLElement>('[data-pencil-name="Advanced"]');
        onClick(advanced, () => {
          if (!advanced) return;
          void openExportPopover(document, advanced, "harness-menu.html", "right").then(
            (harnesses) => {
              if (!harnesses) return;
              for (const choice of harnesses.querySelectorAll<HTMLElement>(
                ":scope > [data-pencil-name]",
              )) {
                const name = choice.dataset.pencilName ?? "";
                const selected = name === state.harness;
                choice.dataset.penkraSelected = String(selected);
                choice.style.backgroundColor = selected ? ROW.active : ROW.default;
                onClick(choice, () => {
                  state.harness = name;
                  saveState();
                  closePopover();
                });
              }
            },
          );
        });
      });
    });
  }
}

function paintCard(card: HTMLElement, selected: boolean, hover = false) {
  card.dataset.penkraSelected = String(selected);
  card.style.backgroundColor = selected ? CARD.activeBackground : CARD.defaultBackground;
  card.style.borderColor = selected
    ? CARD.activeBorder
    : hover
      ? CARD.hoverBorder
      : CARD.defaultBorder;
}

function installAgentCards(document: Document) {
  const cards = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-pencil-name="Agent Row 1"] > [data-pencil-name], [data-pencil-name="Agent Row 2"] > [data-pencil-name], [data-pencil-name="Agent Row 3"] > [data-pencil-name]',
    ),
  ];
  const continueButton = first(document, "Continue Button");

  const sync = () => {
    for (const card of cards) {
      paintCard(card, state.agents.includes(card.dataset.pencilName ?? ""));
    }
    if (continueButton) {
      const disabled = state.agents.length === 0;
      continueButton.setAttribute("aria-disabled", String(disabled));
      paintButton(continueButton, disabled ? "disabled" : "default");
    }
  };

  for (const card of cards) {
    const name = card.dataset.pencilName ?? "";
    onClick(card, () => {
      state.agents = state.agents.includes(name)
        ? state.agents.filter((agent) => agent !== name)
        : [...state.agents, name];
      saveState();
      sync();
    });
    card.addEventListener("pointerenter", () => {
      if (!state.agents.includes(name)) paintCard(card, false, true);
    });
    card.addEventListener("pointerleave", () => paintCard(card, state.agents.includes(name)));
  }
  sync();
}

function editable(
  element: HTMLElement,
  placeholder: string,
  onValue: (value: string) => void,
  options: { secret?: boolean; submit?: () => void } = {},
) {
  const initial = element.textContent?.trim() ?? "";
  element.contentEditable = "plaintext-only";
  element.spellcheck = false;
  element.style.outline = "none";
  element.parentElement?.addEventListener("pointerenter", () => {
    if (element.ownerDocument.activeElement !== element && element.parentElement) {
      element.parentElement.style.borderColor = "#4A4E5E";
    }
  });
  element.parentElement?.addEventListener("pointerleave", () => {
    if (element.ownerDocument.activeElement !== element && element.parentElement) {
      element.parentElement.style.borderColor = "#26272E";
    }
  });
  element.addEventListener("focus", () => {
    if (element.textContent?.trim() === placeholder || element.textContent?.trim() === initial) {
      element.textContent = "";
    }
    element.style.color = "#E8EAF2";
    if (element.parentElement) element.parentElement.style.borderColor = "#3B82F6";
  });
  element.addEventListener("blur", () => {
    if (element.parentElement) element.parentElement.style.borderColor = "#26272E";
    if (!element.textContent?.trim()) {
      element.textContent = placeholder;
      element.style.color = "#6B7088";
    }
  });
  element.addEventListener("input", () => onValue(element.textContent ?? ""));
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || !options.submit) return;
    event.preventDefault();
    options.submit();
  });
}

function setToggle(toggle: HTMLElement, enabled: boolean) {
  toggle.dataset.penkraSelected = String(enabled);
  toggle.style.backgroundColor = enabled ? "#3B82F6" : "#26272E";
  toggle.style.padding = enabled ? "2px 2px 2px 18px" : "2px 18px 2px 2px";
  toggle.setAttribute("aria-pressed", String(enabled));
}

function installToggles(document: Document, phase: Phase) {
  const toggles = [
    ...document.querySelectorAll<HTMLElement>(
      '[data-pencil-name="Switch"], [data-pencil-name="Toggle"]',
    ),
  ];
  toggles.forEach((toggle, index) => {
    const app = toggle.closest<HTMLElement>('[data-pencil-name^="App —"]');
    const name =
      app?.dataset.pencilName?.replace("App — ", "") ??
      toggle.closest<HTMLElement>('[data-pencil-name="Ledger"]')?.dataset.pencilName ??
      `${phase}:${index}`;
    const computedOn = getComputedStyle(toggle).backgroundColor === "rgb(59, 130, 246)";
    const enabled =
      name in state.apps
        ? (state.apps[name] ?? computedOn)
        : name in state.toggles
          ? (state.toggles[name] ?? computedOn)
          : computedOn;
    setToggle(toggle, enabled);
    onClick(toggle, () => {
      const next = toggle.dataset.penkraSelected !== "true";
      setToggle(toggle, next);
      if (app || name === "Ledger") state.apps[name] = next;
      else state.toggles[name] = next;
      saveState();
    });
  });
}

function installSearch(document: Document) {
  const search = all(document, "Placeholder").find(
    (element) => element.textContent?.trim() === "Search apps",
  );
  if (!search) return;
  editable(search, "Search apps", (value) => {
    const query = value.trim().toLowerCase();
    for (const app of document.querySelectorAll<HTMLElement>('[data-pencil-name^="App —"]')) {
      app.style.display = app.textContent?.toLowerCase().includes(query) ? "flex" : "none";
    }
  });
}

function installConnectionControls(document: Document) {
  for (const remove of all(document, "x")) {
    onClick(remove, () => {
      remove.closest<HTMLElement>('[data-pencil-name^="Connection —"]')?.remove();
    });
  }
}

function installThreadControls(document: Document) {
  for (const thread of document.querySelectorAll<HTMLElement>('[data-pencil-name^="Thread —"]')) {
    const label = thread.textContent?.trim().replace(/\s+/g, " ") || "Thread";
    if (state.selectedThread && label === state.selectedThread) {
      thread.dataset.penkraSelected = "true";
      thread.style.backgroundColor = ROW.active;
      setForeground(thread, "#E8EAF2");
    }
    onClick(thread, () => {
      for (const other of document.querySelectorAll<HTMLElement>(
        '[data-pencil-name^="Thread —"]',
      )) {
        other.dataset.penkraSelected = "false";
        other.style.backgroundColor = ROW.default;
      }
      thread.dataset.penkraSelected = "true";
      thread.style.backgroundColor = ROW.active;
      setForeground(thread, "#E8EAF2");
      state.selectedThread = label;
      const topBar = first(document, "Top Bar");
      const title = topBar?.querySelector<HTMLElement>('[data-pencil-name="Title"]');
      if (title) title.textContent = state.selectedThread;
      saveState();
    });
  }
}

function installFolderControls(document: Document) {
  for (const folder of document.querySelectorAll<HTMLElement>('[data-pencil-name^="Folder —"]')) {
    onClick(folder, () => {
      const siblings = folder.parentElement ? [...folder.parentElement.children] : [];
      const index = siblings.indexOf(folder);
      const chevron = folder.querySelector<SVGElement>(
        '[data-pencil-name="Chevron"], [data-pencil-name="Chevron Icon"]',
      );
      const collapsed = folder.dataset.penkraCollapsed === "true";
      folder.dataset.penkraCollapsed = String(!collapsed);
      if (chevron) chevron.style.transform = collapsed ? "" : "rotate(-90deg)";
      for (const sibling of siblings.slice(index + 1)) {
        const element = sibling as HTMLElement;
        const name = element.dataset.pencilName ?? "";
        if (name.startsWith("Folder —")) break;
        if (name.startsWith("Thread —") || name.startsWith("Show more —")) {
          element.style.display = collapsed ? "flex" : "none";
        }
      }
    });
  }
}

function installOptionGroups(document: Document) {
  for (const group of all(document, "Options")) {
    const options = [...group.children].filter(
      (child): child is HTMLElement =>
        child.nodeType === Node.ELEMENT_NODE &&
        (child as HTMLElement).dataset.pencilName?.startsWith("Option ") === true,
    );
    const select = (selected: HTMLElement) => {
      for (const option of options) {
        const active = option === selected;
        option.dataset.penkraSelected = String(active);
        option.style.backgroundColor = active ? "#3B82F614" : "#141519";
        option.style.borderColor = active ? "#1F6FEB" : "#26272E";
        const check = option.querySelector<HTMLElement>('[data-pencil-name="Check"]');
        if (check) check.style.visibility = active ? "visible" : "hidden";
      }
    };
    for (const option of options) onClick(option, () => select(option));
  }
}

function appendMockMessage(document: Document, text: string) {
  const stream = first(document, "Stream");
  const template = stream?.querySelector<HTMLElement>('[data-pencil-name="User Row"]');
  if (!stream || !template) return;
  const clone = template.cloneNode(true) as HTMLElement;
  const user = clone.querySelector<HTMLElement>('[data-pencil-name="User"]');
  if (user) user.textContent = text;
  clone.querySelector<HTMLElement>('[data-pencil-name="Message Actions"]')?.replaceChildren();
  stream.append(clone);
}

function installComposer(document: Document) {
  const composer = all(document, "Placeholder").find(
    (element) => element.textContent?.trim() === "Do anything",
  );
  if (!composer) return;
  const submit = () => {
    const value = composer.textContent?.trim() ?? "";
    if (!value || value === "Do anything") return;
    state.messages.push(value);
    state.composerDraft = "";
    saveState();
    appendMockMessage(document, value);
    composer.textContent = "Do anything";
    composer.style.color = "#6B7088";
  };
  if (state.composerDraft) {
    composer.textContent = state.composerDraft;
    composer.style.color = "#E8EAF2";
  }
  state.messages.forEach((message) => appendMockMessage(document, message));
  editable(
    composer,
    "Do anything",
    (value) => {
      state.composerDraft = value;
      saveState();
    },
    { submit },
  );
  bindName(document, "Send Button", () => submit());
  bindName(document, "Send", () => submit());
}

function installAppearance(document: Document) {
  const choices = ["System", "Dark", "Light"];
  const sync = () => {
    for (const choice of choices) {
      const element = first(document, choice);
      if (!element) continue;
      const selected = state.appearance === choice;
      element.dataset.penkraSelected = String(selected);
      element.style.backgroundColor = selected ? "#3B82F614" : "#141519";
      element.style.borderColor = selected ? "#1F6FEB" : "#26272E";
      const check = element.querySelector<HTMLElement>('[data-pencil-name="Check"]');
      if (check) check.style.visibility = selected ? "visible" : "hidden";
    }
  };
  for (const choice of choices) {
    onClick(first(document, choice), () => {
      state.appearance = choice;
      saveState();
      sync();
    });
  }
  sync();
}

async function injectPermissionSheet(document: Document) {
  const response = await fetch("./pencil/permission-sheet.html");
  const html = await response.text();
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const sheet = parsed.body.firstElementChild?.cloneNode(true) as HTMLElement | undefined;
  if (!sheet) return;
  sheet.style.position = "fixed";
  sheet.style.left = "50%";
  sheet.style.top = "50%";
  sheet.style.transform = "translate(-50%, -50%)";
  sheet.style.zIndex = "100";
  document.body.append(sheet);
  installToggles(document, "permission");
}

const backPhase: Partial<Record<Phase, Phase>> = {
  agents: "welcome",
  connections: "agents",
  "api-key": "connections",
  apps: "connections",
};

export async function installPencilRuntime(
  document: Document,
  phase: Phase,
  callbacks: RuntimeCallbacks,
) {
  document.documentElement.style.userSelect = "none";
  installButtonStates(document);
  installRowStates(document);
  installToggles(document, phase);
  installTooltips(document);

  if (phase === "welcome") {
    bindName(document, "Sign In Button", () => callbacks.go("agents"));
    bindName(document, "Skip Button", () => callbacks.go("agents"));
  }

  const back = backPhase[phase];
  if (back) bindName(document, "Back Button", () => callbacks.go(back));

  if (phase === "agents") {
    installAgentCards(document);
    bindName(document, "Continue Button", () => {
      if (state.agents.length) callbacks.go("connections");
    });
  }

  if (phase === "connections") {
    installConnectionControls(document);
    bindName(document, "Sign in with Claude Button", () => callbacks.go("apps"));
    bindName(document, "Enter API Key Button", () => callbacks.go("api-key"));
  }

  if (phase === "api-key") {
    const placeholders = all(document, "Placeholder");
    const secret = placeholders.find((element) => element.textContent?.includes("••"));
    const name = placeholders.find((element) => element !== secret);
    if (secret)
      editable(
        secret,
        "Enter API key",
        (value) => {
          state.apiKey = value;
          saveState();
        },
        { secret: true },
      );
    if (name)
      editable(name, "Optional key name", (value) => {
        state.keyName = value;
        saveState();
      });
    bindName(document, "Save Button", () => {
      const value = secret?.textContent?.trim() ?? "";
      if (!value || value === "Enter API key" || value.includes("••")) {
        if (secret?.parentElement) secret.parentElement.style.borderColor = "#EF4444";
        return;
      }
      callbacks.go("apps");
    });
  }

  if (phase === "apps") {
    installSearch(document);
    bindName(document, "Continue Button", () => callbacks.go("workspace"));
  }

  const inWorkspace =
    phase === "workspace" ||
    phase === "apps-panel" ||
    phase === "permission" ||
    phase.startsWith("settings");
  if (inWorkspace) {
    bindName(document, "Nav Item — Sites", () => callbacks.go("apps-panel"));
    bindName(document, "Nav Item — New chat", () => {
      state.messages = [];
      state.composerDraft = "";
      saveState();
      callbacks.go("workspace");
    });
    bindName(document, "Panel Icon", () =>
      callbacks.go(phase === "apps-panel" ? "workspace" : "apps-panel"),
    );
    installThreadControls(document);
    installFolderControls(document);
    installComposer(document);
    installOverlayMenus(document, phase, callbacks);
  }

  if (phase === "apps-panel") {
    for (const appName of ["Browser", "Terminal", "Files", "GitHub", "Notion", "Slack", "Linear"]) {
      onClick(first(document, appName), () => {
        const content = first(document, "Panel Content");
        const title = content?.querySelector<HTMLElement>('[data-pencil-name="Title"]');
        if (title) title.textContent = appName;
      });
    }
  }

  if (phase.startsWith("settings")) {
    installOptionGroups(document);
    bindName(document, "General Row", () => callbacks.go("settings"));
    bindName(document, "Permissions Row", () => callbacks.go("settings-permissions"));
    bindName(document, "Agents Row", () => callbacks.go("settings-agents"));
    bindName(document, "Apps Row", () => callbacks.go("settings-apps"));
    bindName(document, "Connectors Row", () => callbacks.go("settings-connectors"));
    bindName(document, "Appearance Row", () => callbacks.go("settings-appearance"));
    bindName(document, "Account Row", () => callbacks.go("settings-account"));
    const backdrop = first(document, "Dim Backdrop");
    backdrop?.addEventListener("click", (event) => {
      if (event.target === backdrop) callbacks.go("workspace");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") callbacks.go("workspace");
    });
  }

  if (phase === "settings-appearance") installAppearance(document);
  if (phase === "settings-apps") {
    onClick(first(document, "Ledger"), () => callbacks.go("permission"));
  }

  if (phase === "permission") {
    first(document, "Permission Sheet — Ledger install")?.remove();
    await injectPermissionSheet(document);
    const backdrop = first(document, "Dim Backdrop");
    backdrop?.addEventListener("click", (event) => {
      if (event.target === backdrop) callbacks.go("settings-apps");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") callbacks.go("settings-apps");
    });
  }
}
