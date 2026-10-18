import type {
  KeybindingRule,
  KeybindingShortcut,
  KeybindingWhenNode,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "@penkra/contracts";

const MAX_WHEN_EXPRESSION_DEPTH = 64;

type WhenToken =
  | { type: "identifier"; value: string }
  | { type: "not" }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" };

const SIDEBAR_SEARCH_DEFAULT_KEYBINDINGS = [
  // Cmd-only on macOS so Ctrl+K stays available for kill-to-end-of-line.
  // Keep Ctrl+K on Windows/Linux (where `mod` would otherwise be Ctrl).
  { key: "cmd+k", command: "sidebar.search" },
  { key: "ctrl+k", command: "sidebar.search", when: "!isMac" },
] as const satisfies ReadonlyArray<KeybindingRule>;

const CHAT_SEARCH_DEFAULT_KEYBINDINGS = [
  { key: "mod+f", command: "chat.search" },
] as const satisfies ReadonlyArray<KeybindingRule>;

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+b", command: "sidebar.toggle" },
  ...SIDEBAR_SEARCH_DEFAULT_KEYBINDINGS,
  ...CHAT_SEARCH_DEFAULT_KEYBINDINGS,
  { key: "mod+shift+o", command: "sidebar.addProject" },
  { key: "mod+i", command: "sidebar.importThread" },
  { key: "mod+alt+arrowleft", command: "space.previous" },
  { key: "mod+alt+arrowright", command: "space.next" },
  { key: "mod+alt+1", command: "space.jump.1" },
  { key: "mod+alt+2", command: "space.jump.2" },
  { key: "mod+alt+3", command: "space.jump.3" },
  { key: "mod+alt+4", command: "space.jump.4" },
  { key: "mod+alt+5", command: "space.jump.5" },
  { key: "mod+alt+6", command: "space.jump.6" },
  { key: "mod+alt+7", command: "space.jump.7" },
  { key: "mod+alt+8", command: "space.jump.8" },
  { key: "mod+alt+9", command: "space.jump.9" },
  { key: "cmd+l", command: "composer.focus.toggle" },
  { key: "mod+shift+m", command: "modelPicker.toggle" },
  // Cycle models within the active provider (favorites first, then remaining list).
  { key: "alt+]", command: "model.next" },
  { key: "alt+[", command: "model.previous" },
  { key: "mod+shift+e", command: "traitsPicker.toggle" },
  { key: "mod+shift+u", command: "settings.usage" },
  { key: "mod+n", command: "chat.new" },
  { key: "mod+shift+n", command: "chat.newLatestProject" },
  { key: "mod+alt+n", command: "chat.newChat" },
  { key: "mod+alt+c", command: "chat.newClaude" },
  { key: "mod+alt+x", command: "chat.newCodex" },
  { key: "mod+alt+r", command: "chat.newOpenCode" },
  { key: "ctrl+tab", command: "view.recent.next" },
  { key: "ctrl+shift+tab", command: "view.recent.previous" },
  { key: "mod+1", command: "thread.jump.1" },
  { key: "mod+2", command: "thread.jump.2" },
  { key: "mod+3", command: "thread.jump.3" },
  { key: "mod+4", command: "thread.jump.4" },
  { key: "mod+5", command: "thread.jump.5" },
  { key: "mod+6", command: "thread.jump.6" },
  { key: "mod+7", command: "thread.jump.7" },
  { key: "mod+8", command: "thread.jump.8" },
  { key: "mod+9", command: "thread.jump.9" },
  { key: "mod+shift+]", command: "chat.visible.next" },
  { key: "mod+shift+[", command: "chat.visible.previous" },
  { key: "mod+o", command: "editor.openFavorite" },
];

function normalizeKeyToken(token: string): string {
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

/** @internal - Exported for testing */
export function parseKeybindingShortcut(value: string): KeybindingShortcut | null {
  const rawTokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  const tokens = [...rawTokens];
  let trailingEmptyCount = 0;
  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount += 1;
    tokens.pop();
  }
  if (trailingEmptyCount > 0) {
    tokens.push("+");
  }
  if (tokens.some((token) => token.length === 0)) {
    return null;
  }
  if (tokens.length === 0) return null;

  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default: {
        if (key !== null) return null;
        key = normalizeKeyToken(token);
      }
    }
  }

  if (key === null) return null;
  return {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    altKey,
    modKey,
  };
}

function tokenizeWhenExpression(expression: string): WhenToken[] | null {
  const tokens: WhenToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const current = expression[index];
    if (!current) break;

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (expression.startsWith("&&", index)) {
      tokens.push({ type: "and" });
      index += 2;
      continue;
    }
    if (expression.startsWith("||", index)) {
      tokens.push({ type: "or" });
      index += 2;
      continue;
    }
    if (current === "!") {
      tokens.push({ type: "not" });
      index += 1;
      continue;
    }
    if (current === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
      continue;
    }
    if (current === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(index));
    if (!identifier) {
      return null;
    }
    tokens.push({ type: "identifier", value: identifier[0] });
    index += identifier[0].length;
  }

  return tokens;
}

function parseKeybindingWhenExpression(expression: string): KeybindingWhenNode | null {
  const tokens = tokenizeWhenExpression(expression);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;

  const parsePrimary = (depth: number): KeybindingWhenNode | null => {
    if (depth > MAX_WHEN_EXPRESSION_DEPTH) {
      return null;
    }
    const token = tokens[index];
    if (!token) return null;

    if (token.type === "identifier") {
      index += 1;
      return { type: "identifier", name: token.value };
    }

    if (token.type === "lparen") {
      index += 1;
      const expressionNode = parseOr(depth + 1);
      const closeToken = tokens[index];
      if (!expressionNode || !closeToken || closeToken.type !== "rparen") {
        return null;
      }
      index += 1;
      return expressionNode;
    }

    return null;
  };

  const parseUnary = (depth: number): KeybindingWhenNode | null => {
    let notCount = 0;
    while (tokens[index]?.type === "not") {
      index += 1;
      notCount += 1;
      if (notCount > MAX_WHEN_EXPRESSION_DEPTH) {
        return null;
      }
    }

    let node = parsePrimary(depth);
    if (!node) return null;

    while (notCount > 0) {
      node = { type: "not", node };
      notCount -= 1;
    }

    return node;
  };

  const parseAnd = (depth: number): KeybindingWhenNode | null => {
    let left = parseUnary(depth);
    if (!left) return null;

    while (tokens[index]?.type === "and") {
      index += 1;
      const right = parseUnary(depth);
      if (!right) return null;
      left = { type: "and", left, right };
    }

    return left;
  };

  const parseOr = (depth: number): KeybindingWhenNode | null => {
    let left = parseAnd(depth);
    if (!left) return null;

    while (tokens[index]?.type === "or") {
      index += 1;
      const right = parseAnd(depth);
      if (!right) return null;
      left = { type: "or", left, right };
    }

    return left;
  };

  const ast = parseOr(0);
  if (!ast || index !== tokens.length) return null;
  return ast;
}

/** @internal - Exported for testing */
export function compileResolvedKeybindingRule(rule: KeybindingRule): ResolvedKeybindingRule | null {
  const shortcut = parseKeybindingShortcut(rule.key);
  if (!shortcut) return null;

  if (rule.when !== undefined) {
    const whenAst = parseKeybindingWhenExpression(rule.when);
    if (!whenAst) return null;
    return {
      command: rule.command,
      shortcut,
      whenAst,
    };
  }

  return {
    command: rule.command,
    shortcut,
  };
}

/** Compile the fixed product table once; an invalid built-in binding is a programming error. */
export const KEYBINDINGS: ResolvedKeybindingsConfig = DEFAULT_KEYBINDINGS.map((rule) => {
  const compiled = compileResolvedKeybindingRule(rule);
  if (!compiled) throw new Error(`Invalid built-in shortcut: ${rule.command}`);
  return compiled;
});
