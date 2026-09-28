import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

export const COVERAGE_ROOTS = [
  "apps/server/src",
  "apps/web/src",
  "apps/desktop/src",
  "packages/shared/src",
] as const;

export type FailureSiteKind = "catch" | "throw" | "rejection" | "timeout";
export interface FailureSite {
  readonly file: string;
  readonly line: number;
  readonly kind: FailureSiteKind;
}

function callKind(node: ts.CallExpression): FailureSiteKind | null {
  const callee = node.expression;
  if (ts.isIdentifier(callee) && callee.text === "setTimeout") return "timeout";
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return null;
  const owner = callee.expression.text;
  const method = callee.name.text;
  if (owner === "Effect" && ["catch", "catchAll", "catchCause"].includes(method)) return "catch";
  if (owner === "Effect" && method === "timeout") return "timeout";
  if (
    (owner === "Effect" && ["fail", "die", "try"].includes(method)) ||
    (owner === "Promise" && method === "reject")
  )
    return "rejection";
  return null;
}

/** Syntax inventory for all production roots; no path allowlist or baseline. */
export function scanFailureSites(file: string, source: string): FailureSite[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: FailureSite[] = [];
  function visit(node: ts.Node): void {
    const kind = ts.isCatchClause(node)
      ? "catch"
      : ts.isThrowStatement(node)
        ? "throw"
        : ts.isCallExpression(node)
          ? callKind(node)
          : null;
    if (kind)
      found.push({
        file,
        line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
        kind,
      });
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return found;
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : walk(full);
    return entry.isFile() &&
      /\.[cm]?[jt]sx?$/u.test(entry.name) &&
      !/\.(test|spec|d)\.[cm]?[jt]sx?$/u.test(entry.name)
      ? [full]
      : [];
  });
}

export function inventoryFailureSites(repoRoot: string): FailureSite[] {
  return COVERAGE_ROOTS.flatMap((root) =>
    walk(path.join(repoRoot, root)).flatMap((file) =>
      scanFailureSites(path.relative(repoRoot, file), fs.readFileSync(file, "utf8")),
    ),
  ).toSorted(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.kind.localeCompare(right.kind),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const sites = inventoryFailureSites(repoRoot);
  const counts = Object.fromEntries(
    (["catch", "throw", "rejection", "timeout"] as const).map((kind) => [
      kind,
      sites.filter((site) => site.kind === kind).length,
    ]),
  );
  process.stdout.write(
    `${JSON.stringify({ roots: COVERAGE_ROOTS, count: sites.length, counts })}\n`,
  );
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(sites)}\n`);
}
