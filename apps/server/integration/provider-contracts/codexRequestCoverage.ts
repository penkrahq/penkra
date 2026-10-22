import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { repositoryRoot } from "./support.ts";

const requestOwners = ["codexAppServerManager.ts", "provider/codexManagedAccountLogin.ts"] as const;

export function methodsFromCodexSource(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const methods = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const index =
        ts.isPropertyAccessExpression(expression) && expression.name.text === "sendRequest"
          ? 2
          : ts.isIdentifier(expression) && expression.text === "request"
            ? 0
            : undefined;
      if (index !== undefined) {
        const method = node.arguments[index];
        assert(
          method && ts.isStringLiteral(method),
          `${file}: native method is not a literal; the contract gate must explicitly cover this call site.`,
        );
        methods.add(method.text);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return [...methods].toSorted();
}

/** New request calls are covered from source, not a hand-maintained method list. */
export async function requiredCodexMethods(): Promise<string[]> {
  const root = path.join(repositoryRoot, "apps/server/src");
  const methods = new Set<string>();
  for (const relative of await readdir(root, { recursive: true })) {
    if (!relative.endsWith(".ts") || relative.endsWith(".test.ts")) continue;
    const text = await readFile(path.join(root, relative), "utf8");
    const ownsTransport = ts
      .preProcessFile(text)
      .importedFiles.some((item) =>
        item.fileName.replace(/\.ts$/, "").endsWith("/codexAppServerTransport"),
      );
    if (!ownsTransport) continue;
    const normalized = relative.split(path.sep).join("/");
    assert(
      requestOwners.some((owner) => owner === normalized),
      `New Codex transport owner ${normalized} must have its request call sites included in the contract gate.`,
    );
    for (const method of methodsFromCodexSource(relative, text)) methods.add(method);
  }
  assert(methods.size > 0, "No production Codex request call sites found.");
  return [...methods].toSorted();
}
