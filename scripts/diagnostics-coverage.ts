import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { isIncidentCode } from "@penkra/shared/diagnostics/codes";
import { validateDiagnosticToken } from "@penkra/shared/diagnostics/privacy";

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
  readonly column: number;
  readonly kind: FailureSiteKind;
}

export interface CoverageException extends FailureSite {
  readonly disposition:
    | "cannot-fail"
    | "validation"
    | "rethrow"
    | "propagates"
    | "scheduled"
    | "recorded"
    | "diagnostics-isolated";
  readonly reason: string;
  readonly reviewer: string;
  readonly issue?: string;
  readonly boundary?: { readonly code: string; readonly where: string };
}

export interface CoverageBoundary {
  readonly code: string;
  readonly where: string;
  readonly file: string;
}

function failureSitePosition(node: ts.Node, parsed: ts.SourceFile): ts.LineAndCharacter {
  const token =
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name
      : node;
  return parsed.getLineAndCharacterOfPosition(token.getStart(parsed));
}

function recordsAtBoundary(source: string, boundary: CoverageBoundary): boolean {
  const parsed = ts.createSourceFile(boundary.file, source, ts.ScriptTarget.Latest, true);
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (isRecordingCall(node, boundary.code, boundary.where)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return found;
}

function isRecordingCall(node: ts.Node, code: string, where: string): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "incident" &&
    where === "browser.socket_connect" &&
    node.arguments[0] !== undefined &&
    ts.isStringLiteralLike(node.arguments[0])
  )
    return node.arguments[0].text === code;
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "recordWsTransportFailure" &&
    code === "EXTERNAL_CALL_FAILED" &&
    node.arguments[0] !== undefined &&
    ts.isStringLiteralLike(node.arguments[0])
  )
    return node.arguments[0].text === where;
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "recordComposerAttachmentFailure" &&
    node.arguments[0] !== undefined &&
    node.arguments[1] !== undefined &&
    ts.isStringLiteralLike(node.arguments[0]) &&
    ts.isStringLiteralLike(node.arguments[1])
  )
    return node.arguments[0].text === code && node.arguments[1].text === where;
  if (
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== "recordDiagnosticIncident" ||
    !node.arguments[0] ||
    !ts.isObjectLiteralExpression(node.arguments[0])
  )
    return false;
  const fields = new Map(
    node.arguments[0].properties
      .filter(ts.isPropertyAssignment)
      .filter(
        (property) =>
          ts.isIdentifier(property.name) && ts.isStringLiteralLike(property.initializer),
      )
      .map((property) => [property.name.getText(), property.initializer.getText().slice(1, -1)]),
  );
  return fields.get("code") === code && fields.get("where") === where;
}

function recordsInsideCatch(
  source: string,
  site: FailureSite,
  code: string,
  where: string,
): boolean {
  const parsed = ts.createSourceFile(site.file, source, ts.ScriptTarget.Latest, true);
  let found = false;
  function containsRecording(node: ts.Node): boolean {
    if (isRecordingCall(node, code, where)) return true;
    if (ts.isFunctionLike(node)) return false;
    return ts.forEachChild(node, containsRecording) === true;
  }
  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isCatchClause(node)) {
      const position = failureSitePosition(node, parsed);
      if (position.line + 1 === site.line && position.character + 1 === site.column) {
        found = containsRecording(node.block);
        return;
      }
    }
    if (ts.isCallExpression(node) && callKind(node) === "catch") {
      const position = failureSitePosition(node, parsed);
      if (position.line + 1 === site.line && position.character + 1 === site.column) {
        const callback = node.arguments[0];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          const body = callback.body;
          found = containsRecording(body);
        }
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return found;
}

/** A local marker must be preceded by a recording statement in its own block. */
function recordsBeforeSite(
  source: string,
  site: FailureSite,
  code: string,
  where: string,
): boolean {
  const parsed = ts.createSourceFile(site.file, source, ts.ScriptTarget.Latest, true);
  let siteNode: ts.Node | undefined;
  function findSite(node: ts.Node): void {
    if (siteNode) return;
    const kind = ts.isCatchClause(node)
      ? "catch"
      : ts.isThrowStatement(node)
        ? "throw"
        : ts.isCallExpression(node)
          ? callKind(node)
          : null;
    const position = failureSitePosition(node, parsed);
    if (
      kind === site.kind &&
      position.line + 1 === site.line &&
      position.character + 1 === site.column
    ) {
      siteNode = node;
      return;
    }
    ts.forEachChild(node, findSite);
  }
  findSite(parsed);
  if (!siteNode) return false;
  let statement: ts.Node = siteNode;
  while (statement.parent && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent))
    statement = statement.parent;
  const block = statement.parent;
  if (!block || (!ts.isBlock(block) && !ts.isSourceFile(block))) return false;
  for (const preceding of block.statements) {
    if (preceding === statement) break;
    if (!ts.isExpressionStatement(preceding)) continue;
    const expression = preceding.expression;
    if (isRecordingCall(expression, code, where)) return true;
    if (!ts.isYieldExpression(expression) || !expression.asteriskToken) continue;
    const effect = expression.expression;
    if (
      !effect ||
      !ts.isCallExpression(effect) ||
      !ts.isPropertyAccessExpression(effect.expression) ||
      !ts.isIdentifier(effect.expression.expression) ||
      effect.expression.expression.text !== "Effect" ||
      effect.expression.name.text !== "sync"
    )
      continue;
    const callback = effect.arguments[0];
    if (callback && ts.isArrowFunction(callback) && isRecordingCall(callback.body, code, where))
      return true;
  }
  return false;
}

/** A recording boundary registry does not establish reachability from a source site. */
export function validateCoverageBoundaries(
  boundaries: ReadonlyArray<CoverageBoundary>,
  sourceFor: (file: string) => string,
): Map<string, string> {
  const registered = new Map<string, string>();
  for (const boundary of boundaries) {
    const key = `${boundary.code}:${boundary.where}`;
    if (!isIncidentCode(boundary.code) || registered.has(key))
      throw new Error(`Invalid or duplicate diagnostics coverage boundary: ${key}`);
    validateDiagnosticToken(boundary.where, "where");
    if (!COVERAGE_ROOTS.some((root) => boundary.file.startsWith(`${root}/`)))
      throw new Error(`Invalid diagnostics coverage boundary file: ${boundary.file}`);
    if (!recordsAtBoundary(sourceFor(boundary.file), boundary))
      throw new Error(`Diagnostics coverage boundary does not record ${key}: ${boundary.file}`);
    registered.set(key, boundary.file);
  }
  return registered;
}

function siteKey(site: FailureSite): string {
  return `${site.file}:${site.line}:${site.column}:${site.kind}`;
}

/** Subsystems own separate exception files so parallel reviews do not edit one list. */
export function loadCoverageExceptions(scriptsDir: string): CoverageException[] {
  const filenames = fs
    .readdirSync(scriptsDir)
    .filter((name) => /^diagnostics-coverage-exceptions(?:\.[a-z0-9_-]+)?\.json$/u.test(name))
    .toSorted();
  const seen = new Set<string>();
  const all: CoverageException[] = [];
  for (const filename of filenames) {
    const entries = JSON.parse(fs.readFileSync(path.join(scriptsDir, filename), "utf8")) as
      | CoverageException[]
      | unknown;
    if (!Array.isArray(entries)) throw new Error(`Invalid coverage exception file: ${filename}`);
    for (const entry of entries as CoverageException[]) {
      const key = siteKey(entry);
      if (seen.has(key)) throw new Error(`Duplicate diagnostics coverage exception: ${key}`);
      seen.add(key);
      all.push(entry);
    }
  }
  return all;
}

function hasCoverageMarker(
  source: string,
  site: FailureSite,
  boundaries: ReadonlyMap<string, string>,
): boolean {
  const lines = source.split(/\r?\n/u);
  const previous = lines[site.line - 2] ?? "";
  const current = lines[site.line - 1] ?? "";
  const markerPattern =
    /(?:\/\/|\/\*)\s*diagnostics-(covered|propagates):\s*([A-Z][A-Z0-9_]*)(?:\s+([a-z][a-z0-9._-]*))?/u;
  const marker =
    markerPattern.exec(current) ??
    (previous.trim().startsWith("//") ? markerPattern.exec(previous) : null);
  if (!marker || !isIncidentCode(marker[2]!)) return false;
  try {
    validateDiagnosticToken(marker[3] ?? "", "where");
    const recordingFile = boundaries.get(`${marker[2]}:${marker[3]}`);
    return Boolean(
      marker[1] === "covered" &&
      recordingFile === site.file &&
      recordsBeforeSite(source, site, marker[2]!, marker[3]!),
    );
  } catch {
    return false;
  }
}

/** Reject unclassified sites and stale or blanket exceptions. */
export function uncoveredFailureSites(
  sites: ReadonlyArray<FailureSite>,
  sourceFor: (file: string) => string,
  exceptions: ReadonlyArray<CoverageException>,
  boundaries: ReadonlyMap<string, string> = new Map(),
): FailureSite[] {
  const known = new Set(sites.map(siteKey));
  const reviewed = new Set<string>();
  const lineCounts = new Map<string, number>();
  for (const site of sites) {
    const lineKey = `${site.file}:${site.line}`;
    lineCounts.set(lineKey, (lineCounts.get(lineKey) ?? 0) + 1);
  }
  for (const entry of exceptions) {
    const key = siteKey(entry);
    const needsBoundary = ["rethrow", "propagates", "recorded"].includes(entry.disposition);
    const boundaryKey = entry.boundary ? `${entry.boundary.code}:${entry.boundary.where}` : null;
    if (
      !known.has(key) ||
      reviewed.has(key) ||
      ![
        "cannot-fail",
        "validation",
        "rethrow",
        "propagates",
        "scheduled",
        "recorded",
        "diagnostics-isolated",
      ].includes(entry.disposition) ||
      (entry.disposition === "validation" && !["throw", "rejection"].includes(entry.kind)) ||
      (entry.disposition === "rethrow" && entry.kind !== "throw") ||
      (entry.disposition === "scheduled" && entry.kind !== "timeout") ||
      (entry.disposition === "recorded" &&
        (entry.kind !== "catch" ||
          !entry.boundary ||
          !recordsInsideCatch(
            sourceFor(entry.file),
            entry,
            entry.boundary.code,
            entry.boundary.where,
          ))) ||
      (needsBoundary && (!boundaryKey || !boundaries.has(boundaryKey))) ||
      (!needsBoundary && entry.boundary !== undefined) ||
      entry.reason.trim().length < 20 ||
      entry.reviewer.trim().length < 2 ||
      (entry.issue !== undefined && !entry.issue.startsWith("https://"))
    )
      throw new Error(`Invalid or stale diagnostics coverage exception: ${key}`);
    reviewed.add(key);
  }
  const sources = new Map<string, string>();
  return sites.filter((site) => {
    if (reviewed.has(siteKey(site))) return false;
    let source = sources.get(site.file);
    if (source === undefined) {
      source = sourceFor(site.file);
      sources.set(site.file, source);
    }
    return (
      lineCounts.get(`${site.file}:${site.line}`) !== 1 ||
      !hasCoverageMarker(source, site, boundaries)
    );
  });
}

function callKind(node: ts.CallExpression): FailureSiteKind | null {
  const callee = node.expression;
  if (ts.isIdentifier(callee) && callee.text === "setTimeout") return "timeout";
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name.text;
  if (method === "catch") return "catch";
  if (!ts.isIdentifier(callee.expression)) return null;
  const owner = callee.expression.text;
  if (
    owner === "Effect" &&
    ["catchAll", "catchCause", "catchIf", "catchTag", "catchTags"].includes(method)
  )
    return "catch";
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
    if (kind) {
      const position = failureSitePosition(node, parsed);
      found.push({
        file,
        line: position.line + 1,
        column: position.character + 1,
        kind,
      });
    }
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
      left.column - right.column ||
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
  if (process.argv.includes("--check")) {
    const exceptions = loadCoverageExceptions(path.join(repoRoot, "scripts"));
    const boundaryPath = path.join(repoRoot, "scripts/diagnostics-coverage-boundaries.json");
    const boundaryList = JSON.parse(fs.readFileSync(boundaryPath, "utf8")) as CoverageBoundary[];
    const sourceFor = (file: string) => fs.readFileSync(path.join(repoRoot, file), "utf8");
    const boundaries = validateCoverageBoundaries(boundaryList, sourceFor);
    const uncovered = uncoveredFailureSites(sites, sourceFor, exceptions, boundaries);
    process.stdout.write(
      `${JSON.stringify({ uncovered: uncovered.length, first: uncovered.slice(0, 20) })}\n`,
    );
    if (uncovered.length > 0) process.exitCode = 1;
  }
}
