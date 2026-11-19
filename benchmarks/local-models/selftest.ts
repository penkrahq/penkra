// Checks each task's checker: untouched workspace fails, reference solution passes.
import * as fs from "node:fs"; import * as os from "node:os"; import * as path from "node:path";
import { TASKS } from "./tasks.ts";
const fixes: Record<string, [(r: string) => void, string]> = {
  "answer-from-file": [() => {}, "4317"],
  "find-file": [() => {}, "src/billing/format.ts"],
  "rename-constant": [(r) => fs.writeFileSync(`${r}/src/limits.ts`, "export const MAX_RETRIES = 5;\nexport const TIMEOUT_MS = 3000;\n"), ""],
  "create-file": [(r) => { fs.mkdirSync(`${r}/notes`); fs.writeFileSync(`${r}/notes/todo.md`, "- [ ] Buy milk\n- [ ] Call Sam\n"); }, ""],
  "no-tool-needed": [() => {}, "It returns a boolean: true if the array contains the value."],
  "fix-failing-test": [(r) => fs.writeFileSync(`${r}/math.ts`, fs.readFileSync(`${r}/math.ts`, "utf8").replace("let i = 1", "let i = 0")), ""],
  "add-feature-with-test": [(r) => fs.appendFileSync(`${r}/src/text.ts`, 'export function slugify(t: string) { return t.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }\n'), ""],
  "multi-file-refactor": [(r) => { for (const f of ["db", "api", "admin"]) { const p = `${r}/src/${f}.ts`; fs.writeFileSync(p, fs.readFileSync(p, "utf8").replaceAll("getUsr", "getUser")); } }, ""],
  "long-context-lookup": [() => {}, "cobalt heron"],
  "debug-from-error": [(r) => fs.writeFileSync(`${r}/main.ts`, fs.readFileSync(`${r}/main.ts`, "utf8").replace("orders.items", "orders.orders")), ""],
};
let bad = 0;
for (const t of TASKS) {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "st-")); t.setup(a); const before = t.check(a, "");
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "st-")); t.setup(b); const [fix, ans] = fixes[t.id]!; fix(b); const after = t.check(b, ans);
  const ok = !before && after; if (!ok) bad++;
  console.log(`${ok ? "ok " : "BAD"} ${t.id} unsolved=${before} solved=${after}`);
}
process.exit(bad ? 1 : 0);
