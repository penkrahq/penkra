// Task suite for the local-model harness.
// basic: the bar every listed model must clear (small models included).
// full:  real agent work; strong models should pass most of these.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type Task = {
  id: string;
  tier: "basic" | "full";
  prompt: string;
  setup: (root: string) => void;
  check: (root: string, answer: string) => boolean;
};

function write(root: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), c);
  }
}
const read = (root: string, p: string) => {
  try {
    return fs.readFileSync(path.join(root, p), "utf8");
  } catch {
    return "";
  }
};
const testsPass = (root: string, file: string) =>
  spawnSync("bun", ["test", file], { cwd: root, encoding: "utf8", timeout: 60_000 }).status === 0;

// Long file with one relevant fact buried in the middle.
function padding(lines: number, seed: string): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(`export const ${seed}${i} = { id: ${i}, label: "${seed} item ${i}", enabled: ${i % 3 === 0} };`);
  }
  return out.join("\n");
}

export const TASKS: Task[] = [
  {
    id: "answer-from-file",
    tier: "basic",
    prompt: "What port does the dev server use? Look in the project and answer with just the number.",
    setup: (r) => write(r, { "config/server.json": JSON.stringify({ host: "127.0.0.1", port: 4317, logLevel: "info" }, null, 2), "README.md": "# demo\n" }),
    check: (_r, a) => /\b4317\b/.test(a),
  },
  {
    id: "find-file",
    tier: "basic",
    prompt: "Which file defines the function `formatInvoiceTotal`? Answer with the path.",
    setup: (r) =>
      write(r, {
        "src/index.ts": 'export * from "./billing/format";\n',
        "src/billing/format.ts": "export function formatInvoiceTotal(cents: number) {\n  return `$${(cents / 100).toFixed(2)}`;\n}\n",
        "src/users.ts": "export const users = [];\n",
      }),
    check: (_r, a) => a.includes("src/billing/format.ts") || a.includes("billing/format.ts"),
  },
  {
    id: "rename-constant",
    tier: "basic",
    prompt: "In src/limits.ts change the MAX_RETRIES value from 3 to 5. Don't change anything else.",
    setup: (r) => write(r, { "src/limits.ts": "export const MAX_RETRIES = 3;\nexport const TIMEOUT_MS = 3000;\n" }),
    check: (r) => read(r, "src/limits.ts") === "export const MAX_RETRIES = 5;\nexport const TIMEOUT_MS = 3000;\n",
  },
  {
    id: "create-file",
    tier: "basic",
    prompt: "Create a file notes/todo.md containing a markdown checklist with exactly these items: Buy milk, Call Sam.",
    setup: (r) => write(r, { "README.md": "# demo\n" }),
    check: (r) => {
      const t = read(r, "notes/todo.md");
      return /- \[ \] Buy milk/i.test(t) && /- \[ \] Call Sam/i.test(t);
    },
  },
  {
    id: "no-tool-needed",
    tier: "basic",
    prompt: "In one sentence: what does the JavaScript `Array.prototype.includes` method return?",
    setup: () => {},
    check: (_r, a) => /boolean|true|false/i.test(a) && a.length < 600,
  },
  {
    id: "fix-failing-test",
    tier: "full",
    prompt: "The tests in math.test.ts fail. Run them, find the bug in math.ts, and fix it. Don't change the tests.",
    setup: (r) =>
      write(r, {
        "math.ts": "export function average(xs: number[]): number {\n  if (xs.length === 0) return 0;\n  let sum = 0;\n  for (let i = 1; i < xs.length; i++) sum += xs[i];\n  return sum / xs.length;\n}\n",
        "math.test.ts": 'import { expect, test } from "bun:test";\nimport { average } from "./math";\ntest("average", () => {\n  expect(average([2, 4, 6])).toBe(4);\n  expect(average([])).toBe(0);\n  expect(average([5])).toBe(5);\n});\n',
      }),
    check: (r) => read(r, "math.test.ts").includes("toBe(4)") && testsPass(r, "math.test.ts"),
  },
  {
    id: "add-feature-with-test",
    tier: "full",
    prompt: "Add a `slugify(title: string): string` export to src/text.ts that lowercases, trims, replaces runs of non-alphanumeric characters with a single '-', and strips leading/trailing '-'. Make the existing tests in src/text.test.ts pass.",
    setup: (r) =>
      write(r, {
        "src/text.ts": "export function capitalize(s: string): string {\n  return s.charAt(0).toUpperCase() + s.slice(1);\n}\n",
        "src/text.test.ts": 'import { expect, test } from "bun:test";\nimport { capitalize, slugify } from "./text";\ntest("capitalize", () => expect(capitalize("hi")).toBe("Hi"));\ntest("slugify", () => {\n  expect(slugify("  Hello, World!  ")).toBe("hello-world");\n  expect(slugify("Penkra -- Local Models 2026")).toBe("penkra-local-models-2026");\n  expect(slugify("---")).toBe("");\n});\n',
      }),
    check: (r) => testsPass(r, "src/text.test.ts"),
  },
  {
    id: "multi-file-refactor",
    tier: "full",
    prompt: "Rename the function `getUsr` to `getUser` everywhere in src/ (definition and all call sites). Then run `bun test` to make sure everything still passes.",
    setup: (r) =>
      write(r, {
        "src/db.ts": 'export function getUsr(id: number) {\n  return { id, name: "user" + id };\n}\n',
        "src/api.ts": 'import { getUsr } from "./db";\nexport const handler = (id: number) => getUsr(id).name;\n',
        "src/admin.ts": 'import { getUsr } from "./db";\nexport const adminName = () => getUsr(1).name.toUpperCase();\n',
        "src/all.test.ts": 'import { expect, test } from "bun:test";\nimport { handler } from "./api";\nimport { adminName } from "./admin";\nimport * as db from "./db";\ntest("renamed", () => {\n  expect(handler(2)).toBe("user2");\n  expect(adminName()).toBe("USER1");\n  expect("getUser" in db).toBe(true);\n});\n',
      }),
    check: (r) =>
      !["src/db.ts", "src/api.ts", "src/admin.ts"].some((f) => read(r, f).includes("getUsr")) && testsPass(r, "src/all.test.ts"),
  },
  {
    id: "long-context-lookup",
    tier: "full",
    prompt: "Read src/registry.ts. What is the label of the entry whose id is 1337? Answer with the exact label.",
    setup: (r) => {
      const before = padding(1300, "alpha");
      const after = padding(1300, "omega");
      write(r, { "src/registry.ts": `${before}\nexport const special = { id: 1337, label: "cobalt heron", enabled: true };\n${after}\n` });
    },
    check: (_r, a) => /cobalt heron/i.test(a),
  },
  {
    id: "debug-from-error",
    tier: "full",
    prompt: "Running `bun run main.ts` crashes. Find out why and fix main.ts so it prints the total.",
    setup: (r) =>
      write(r, {
        "main.ts": 'import { readFileSync } from "node:fs";\nconst orders = JSON.parse(readFileSync("orders.json", "utf8"));\nconst total = orders.items.reduce((s: number, o: { price: number }) => s + o.price, 0);\nconsole.log("total", total);\n',
        "orders.json": JSON.stringify({ orders: [{ price: 5 }, { price: 7 }] }),
      }),
    check: (r) => {
      const res = spawnSync("bun", ["run", "main.ts"], { cwd: r, encoding: "utf8", timeout: 30_000 });
      return res.status === 0 && /total 12\b/.test(res.stdout);
    },
  },
];
