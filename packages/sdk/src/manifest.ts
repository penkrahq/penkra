export const PENKRA_APP_MANIFEST_VERSION = 1 as const;

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface AppEntrypoints {
  /** Local visual entry document, conventionally `app.html`. */
  app: string;
  /** Optional isolated controller entry document, conventionally `operations.html`. */
  operations?: string;
}

export interface AppPermissionDeclaration {
  /** Stable, platform-defined permission name such as `network-fetch`. */
  name: string;
  /** Required permissions are reviewed before installation can complete. */
  required: boolean;
  /** Concise user-visible explanation of why the App needs this authority. */
  reason: string;
}

export interface OperationDeclaration {
  /** App-local dotted key, for example `issues.create`; never includes the App slug. */
  key: string;
  /** Concise help text used by generated CLI and agent help. */
  summary: string;
  /** JSON Schema for caller-supplied input. */
  input: JsonSchema;
  /** JSON Schema for the successful result. */
  output: JsonSchema;
  /** Controller-local handler key. */
  handler: string;
}

export interface PenkraAppManifest {
  manifestVersion: typeof PENKRA_APP_MANIFEST_VERSION;
  /** Immutable reverse-domain identity, such as `com.penkra.apps`. */
  id: string;
  /** Globally unique, stable, human/agent-facing command root. */
  slug: string;
  name: string;
  /** One-line card and search description; rich content belongs in README.md. */
  summary: string;
  version: string;
  compatibility: {
    /** Supported Penkra host semantic-version range. */
    penkra: string;
  };
  icons: ReadonlyArray<{
    src: string;
    sizes: string;
    type: string;
  }>;
  entrypoints: AppEntrypoints;
  permissions?: ReadonlyArray<AppPermissionDeclaration>;
  operations?: ReadonlyArray<OperationDeclaration>;
}

export interface AppManifestValidationIssue {
  path: string;
  code:
    | "duplicate"
    | "invalid-format"
    | "invalid-manifest-version"
    | "missing"
    | "unsafe-path";
  message: string;
}

export type AppManifestValidationResult =
  | { ok: true; manifest: PenkraAppManifest }
  | { ok: false; issues: ReadonlyArray<AppManifestValidationIssue> };

const APP_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,}$/;
const APP_SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PERMISSION_NAME_PATTERN = APP_SLUG_PATTERN;
const OPERATION_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafePackagePath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\") || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return false;
  }
  return !value.split(/[\\/]/).some((segment) => segment === ".." || segment.length === 0);
}

function issue(
  issues: AppManifestValidationIssue[],
  path: string,
  code: AppManifestValidationIssue["code"],
  message: string,
): void {
  issues.push({ path, code, message });
}

function requireString(
  value: unknown,
  path: string,
  issues: AppManifestValidationIssue[],
): value is string {
  if (nonEmptyString(value)) return true;
  issue(issues, path, "missing", `${path} must be a non-empty string.`);
  return false;
}

function validateEntrypoint(
  value: unknown,
  path: string,
  issues: AppManifestValidationIssue[],
): void {
  if (!requireString(value, path, issues)) return;
  if (!isSafePackagePath(value)) {
    issue(issues, path, "unsafe-path", `${path} must be a package-relative path.`);
  }
}

function validateUniqueNames(
  values: ReadonlyArray<{ name: string; path: string }>,
  issues: AppManifestValidationIssue[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.name)) {
      issue(issues, value.path, "duplicate", `${value.name} is declared more than once.`);
    }
    seen.add(value.name);
  }
}

export function validateAppManifest(value: unknown): AppManifestValidationResult {
  const issues: AppManifestValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [{ path: "$", code: "invalid-format", message: "Manifest must be an object." }],
    };
  }

  if (value.manifestVersion !== PENKRA_APP_MANIFEST_VERSION) {
    issue(
      issues,
      "manifestVersion",
      "invalid-manifest-version",
      `manifestVersion must be ${PENKRA_APP_MANIFEST_VERSION}.`,
    );
  }
  if (requireString(value.id, "id", issues) && !APP_ID_PATTERN.test(value.id)) {
    issue(issues, "id", "invalid-format", "id must be a lowercase reverse-domain identifier.");
  }
  if (requireString(value.slug, "slug", issues) && !APP_SLUG_PATTERN.test(value.slug)) {
    issue(issues, "slug", "invalid-format", "slug must be lowercase words joined by hyphens.");
  }
  requireString(value.name, "name", issues);
  requireString(value.summary, "summary", issues);
  requireString(value.version, "version", issues);

  if (!isRecord(value.compatibility)) {
    issue(issues, "compatibility", "missing", "compatibility must be an object.");
  } else {
    requireString(value.compatibility.penkra, "compatibility.penkra", issues);
  }

  if (!isRecord(value.entrypoints)) {
    issue(issues, "entrypoints", "missing", "entrypoints must be an object.");
  } else {
    validateEntrypoint(value.entrypoints.app, "entrypoints.app", issues);
    if (value.entrypoints.operations !== undefined) {
      validateEntrypoint(value.entrypoints.operations, "entrypoints.operations", issues);
    }
  }

  if (!Array.isArray(value.icons) || value.icons.length === 0) {
    issue(issues, "icons", "missing", "icons must contain at least one icon.");
  } else {
    value.icons.forEach((candidate, index) => {
      const path = `icons[${index}]`;
      if (!isRecord(candidate)) {
        issue(issues, path, "invalid-format", `${path} must be an object.`);
        return;
      }
      validateEntrypoint(candidate.src, `${path}.src`, issues);
      requireString(candidate.sizes, `${path}.sizes`, issues);
      if (
        requireString(candidate.type, `${path}.type`, issues) &&
        !MIME_TYPE_PATTERN.test(candidate.type)
      ) {
        issue(issues, `${path}.type`, "invalid-format", `${path}.type must be a MIME type.`);
      }
    });
  }

  const permissionNames: Array<{ name: string; path: string }> = [];
  if (value.permissions !== undefined) {
    if (!Array.isArray(value.permissions)) {
      issue(issues, "permissions", "invalid-format", "permissions must be an array.");
    } else {
      value.permissions.forEach((candidate, index) => {
        const path = `permissions[${index}]`;
        if (!isRecord(candidate)) {
          issue(issues, path, "invalid-format", `${path} must be an object.`);
          return;
        }
        if (
          requireString(candidate.name, `${path}.name`, issues) &&
          !PERMISSION_NAME_PATTERN.test(candidate.name)
        ) {
          issue(
            issues,
            `${path}.name`,
            "invalid-format",
            "Permission names must be lowercase words joined by hyphens.",
          );
        } else if (typeof candidate.name === "string") {
          permissionNames.push({ name: candidate.name, path: `${path}.name` });
        }
        if (typeof candidate.required !== "boolean") {
          issue(issues, `${path}.required`, "invalid-format", "required must be a boolean.");
        }
        requireString(candidate.reason, `${path}.reason`, issues);
      });
    }
  }
  validateUniqueNames(permissionNames, issues);

  const operationNames: Array<{ name: string; path: string }> = [];
  if (value.operations !== undefined) {
    if (!Array.isArray(value.operations)) {
      issue(issues, "operations", "invalid-format", "operations must be an array.");
    } else {
      value.operations.forEach((candidate, index) => {
        const path = `operations[${index}]`;
        if (!isRecord(candidate)) {
          issue(issues, path, "invalid-format", `${path} must be an object.`);
          return;
        }
        if (
          requireString(candidate.key, `${path}.key`, issues) &&
          !OPERATION_KEY_PATTERN.test(candidate.key)
        ) {
          issue(
            issues,
            `${path}.key`,
            "invalid-format",
            "Operation keys must be lowercase dot-separated words.",
          );
        } else if (typeof candidate.key === "string") {
          operationNames.push({ name: candidate.key, path: `${path}.key` });
          if (typeof value.slug === "string" && candidate.key.startsWith(`${value.slug}.`)) {
            issue(
              issues,
              `${path}.key`,
              "invalid-format",
              "Operation keys are App-local and must not repeat the App slug.",
            );
          }
        }
        requireString(candidate.summary, `${path}.summary`, issues);
        if (!isRecord(candidate.input)) {
          issue(issues, `${path}.input`, "invalid-format", "input must be a JSON Schema object.");
        }
        if (!isRecord(candidate.output)) {
          issue(issues, `${path}.output`, "invalid-format", "output must be a JSON Schema object.");
        }
        requireString(candidate.handler, `${path}.handler`, issues);
      });
    }
  }
  validateUniqueNames(operationNames, issues);

  return issues.length === 0
    ? { ok: true, manifest: value as unknown as PenkraAppManifest }
    : { ok: false, issues };
}

export function assertAppManifest(value: unknown): asserts value is PenkraAppManifest {
  const result = validateAppManifest(value);
  if (result.ok) return;
  throw new TypeError(result.issues.map((entry) => `${entry.path}: ${entry.message}`).join("\n"));
}

export function defineApp<const Manifest extends PenkraAppManifest>(manifest: Manifest): Manifest {
  assertAppManifest(manifest);
  return manifest;
}
