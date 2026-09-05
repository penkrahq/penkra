interface KeyDefinition {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
}

const namedKeys: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Escape: 27,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
};
const modifierBits: Record<string, number> = {
  Alt: 1,
  Option: 1,
  Ctrl: 2,
  Control: 2,
  Meta: 4,
  Command: 4,
  Cmd: 4,
  Shift: 8,
};
const punctuation: Record<string, [string, number]> = {
  " ": ["Space", 32],
  ";": ["Semicolon", 186],
  ":": ["Semicolon", 186],
  "=": ["Equal", 187],
  "+": ["Equal", 187],
  ",": ["Comma", 188],
  "<": ["Comma", 188],
  "-": ["Minus", 189],
  _: ["Minus", 189],
  ".": ["Period", 190],
  ">": ["Period", 190],
  "/": ["Slash", 191],
  "?": ["Slash", 191],
  "`": ["Backquote", 192],
  "~": ["Backquote", 192],
  "[": ["BracketLeft", 219],
  "{": ["BracketLeft", 219],
  "\\": ["Backslash", 220],
  "|": ["Backslash", 220],
  "]": ["BracketRight", 221],
  "}": ["BracketRight", 221],
  "'": ["Quote", 222],
  '"': ["Quote", 222],
};
const shiftedPunctuation: Record<string, string> = {
  ";": ":",
  "=": "+",
  ",": "<",
  "-": "_",
  ".": ">",
  "/": "?",
  "`": "~",
  "[": "{",
  "\\": "|",
  "]": "}",
  "'": '"',
};

export function appTabKeyDefinition(input: string): KeyDefinition {
  let key = input;
  let modifiers = 0;
  while (key.includes("+") && key !== "+") {
    const separator = key.indexOf("+");
    const modifier = key.slice(0, separator);
    const bit = modifierBits[modifier];
    if (typeof bit !== "number") throw new Error(`Unknown keyboard modifier: ${modifier}`);
    modifiers |= bit;
    key = key.slice(separator + 1);
  }
  const aliases: Record<string, string> = { Esc: "Escape", Return: "Enter", Spacebar: "Space" };
  if (Object.hasOwn(aliases, key)) key = aliases[key] ?? key;
  let code = key;
  const punctuationDefinition = Object.hasOwn(punctuation, key) ? punctuation[key] : undefined;
  let windowsVirtualKeyCode = Object.hasOwn(namedKeys, key) ? (namedKeys[key] ?? 0) : 0;
  if (/^[a-z]$/iu.test(key)) {
    code = `Key${key.toUpperCase()}`;
    windowsVirtualKeyCode = key.toUpperCase().charCodeAt(0);
    if (modifiers & 8) key = key.toUpperCase();
  } else if (/^[0-9]$/u.test(key)) {
    code = `Digit${key}`;
    windowsVirtualKeyCode = key.charCodeAt(0);
    if (modifiers & 8) key = ")!@#$%^&*("[Number(key)] ?? key;
  } else if (")!@#$%^&*(".includes(key) && key.length === 1) {
    const digit = ")!@#$%^&*(".indexOf(key);
    code = `Digit${digit}`;
    windowsVirtualKeyCode = 48 + digit;
  } else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(key)) {
    windowsVirtualKeyCode = 111 + Number(key.slice(1));
  } else if (punctuationDefinition) {
    [code, windowsVirtualKeyCode] = punctuationDefinition;
    if (modifiers & 8) key = shiftedPunctuation[key] ?? key;
  } else if (!windowsVirtualKeyCode) {
    throw new Error(`Unsupported keyboard key: ${key}`);
  }
  if (key === "Space") key = " ";
  if (["Shift", "Control", "Alt", "Meta"].includes(code)) code += "Left";
  const text =
    modifiers & 7 ? undefined : key === "Enter" ? "\r" : key.length === 1 ? key : undefined;
  return { key, code, windowsVirtualKeyCode, modifiers, ...(text ? { text } : {}) };
}
