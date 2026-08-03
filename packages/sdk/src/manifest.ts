import { validatePenkraJsonSchema } from "./jsonSchema";
import { isPenkraPermissionName } from "./permissions";

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

export type AppSettingDeclaration =
  | {
      key: string;
      label: string;
      description?: string;
      migrationId?: string;
      type: "boolean";
      default: boolean;
    }
  | {
      key: string;
      label: string;
      description?: string;
      migrationId?: string;
      type: "string";
      default: string;
      sensitive?: boolean;
      validation?: { minLength?: number; maxLength?: number };
    }
  | {
      key: string;
      label: string;
      description?: string;
      migrationId?: string;
      type: "number";
      default: number;
      validation?: { minimum?: number; maximum?: number; step?: number };
    }
  | {
      key: string;
      label: string;
      description?: string;
      migrationId?: string;
      type: "select";
      default: string;
      options: ReadonlyArray<{ value: string; label: string }>;
    };

export interface AppSkillDeclaration {
  /** Package-relative directory containing one Agent Skills-compatible SKILL.md. */
  path: string;
}

export type AppHandlerDeclaration =
  | {
      intent: "open-url";
      operation: string;
      schemes: ReadonlyArray<string>;
    }
  | {
      intent: "open-file";
      operation: string;
      extensions: ReadonlyArray<string>;
    }
  | {
      intent: "open-directory";
      operation: string;
    };

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
  contributions?: {
    settings?: ReadonlyArray<AppSettingDeclaration>;
    skills?: ReadonlyArray<AppSkillDeclaration>;
    handlers?: ReadonlyArray<AppHandlerDeclaration>;
  };
}

export interface AppManifestValidationIssue {
  path: string;
  code: "duplicate" | "invalid-format" | "invalid-manifest-version" | "missing" | "unsafe-path";
  message: string;
}

export type AppManifestValidationResult =
  | { ok: true; manifest: PenkraAppManifest }
  | { ok: false; issues: ReadonlyArray<AppManifestValidationIssue> };

const APP_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,}$/;
const APP_SLUG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PERMISSION_NAME_PATTERN = APP_SLUG_PATTERN;
const OPERATION_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const CONTRIBUTION_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
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
        } else if (typeof candidate.name === "string" && !isPenkraPermissionName(candidate.name)) {
          issue(
            issues,
            `${path}.name`,
            "invalid-format",
            `${candidate.name} is not a supported Penkra permission.`,
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
        } else {
          for (const message of validatePenkraJsonSchema(candidate.input)) {
            issue(issues, `${path}.input`, "invalid-format", `input ${message}.`);
          }
        }
        if (!isRecord(candidate.output)) {
          issue(issues, `${path}.output`, "invalid-format", "output must be a JSON Schema object.");
        } else {
          for (const message of validatePenkraJsonSchema(candidate.output)) {
            issue(issues, `${path}.output`, "invalid-format", `output ${message}.`);
          }
        }
        requireString(candidate.handler, `${path}.handler`, issues);
      });
    }
  }
  validateUniqueNames(operationNames, issues);
  if (
    Array.isArray(value.operations) &&
    value.operations.length > 0 &&
    isRecord(value.entrypoints) &&
    value.entrypoints.operations === undefined
  ) {
    issue(
      issues,
      "entrypoints.operations",
      "missing",
      "Apps that declare operations must provide a controller entrypoint.",
    );
  }

  validateContributions(value.contributions, value.operations, issues);

  return issues.length === 0
    ? { ok: true, manifest: value as unknown as PenkraAppManifest }
    : { ok: false, issues };
}

function validateContributions(
  value: unknown,
  operations: unknown,
  issues: AppManifestValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issue(issues, "contributions", "invalid-format", "contributions must be an object.");
    return;
  }
  const settingNames: Array<{ name: string; path: string }> = [];
  if (value.settings !== undefined) {
    if (!Array.isArray(value.settings)) {
      issue(issues, "contributions.settings", "invalid-format", "settings must be an array.");
    } else {
      value.settings.forEach((candidate, index) => {
        const path = `contributions.settings[${index}]`;
        if (!isRecord(candidate)) {
          issue(issues, path, "invalid-format", `${path} must be an object.`);
          return;
        }
        if (
          requireString(candidate.key, `${path}.key`, issues) &&
          !CONTRIBUTION_KEY_PATTERN.test(candidate.key)
        ) {
          issue(
            issues,
            `${path}.key`,
            "invalid-format",
            "Setting keys must be lowercase hyphenated identifiers.",
          );
        } else if (typeof candidate.key === "string") {
          settingNames.push({ name: candidate.key, path: `${path}.key` });
        }
        requireString(candidate.label, `${path}.label`, issues);
        if (candidate.description !== undefined) {
          requireString(candidate.description, `${path}.description`, issues);
        }
        if (
          candidate.migrationId !== undefined &&
          (!nonEmptyString(candidate.migrationId) ||
            !CONTRIBUTION_KEY_PATTERN.test(candidate.migrationId))
        ) {
          issue(
            issues,
            `${path}.migrationId`,
            "invalid-format",
            "migrationId must be a lowercase hyphenated identifier.",
          );
        }
        validateSettingDeclaration(candidate, path, issues);
      });
    }
  }
  validateUniqueNames(settingNames, issues);

  const skillPaths: Array<{ name: string; path: string }> = [];
  if (value.skills !== undefined) {
    if (!Array.isArray(value.skills)) {
      issue(issues, "contributions.skills", "invalid-format", "skills must be an array.");
    } else {
      value.skills.forEach((candidate, index) => {
        const path = `contributions.skills[${index}]`;
        if (!isRecord(candidate)) {
          issue(issues, path, "invalid-format", `${path} must be an object.`);
          return;
        }
        if (requireString(candidate.path, `${path}.path`, issues)) {
          if (!isSafePackagePath(candidate.path)) {
            issue(
              issues,
              `${path}.path`,
              "unsafe-path",
              `${path}.path must be a package-relative directory.`,
            );
          } else {
            skillPaths.push({ name: candidate.path, path: `${path}.path` });
          }
        }
      });
    }
  }
  validateUniqueNames(skillPaths, issues);
  validateHandlerContributions(value.handlers, operations, issues);
}

function validateSettingDeclaration(
  candidate: Record<string, unknown>,
  path: string,
  issues: AppManifestValidationIssue[],
): void {
  if (!["boolean", "string", "number", "select"].includes(String(candidate.type))) {
    issue(
      issues,
      `${path}.type`,
      "invalid-format",
      "Setting type must be boolean, string, number, or select.",
    );
    return;
  }
  if (candidate.type === "boolean" && typeof candidate.default !== "boolean") {
    issue(
      issues,
      `${path}.default`,
      "invalid-format",
      "Boolean setting default must be a boolean.",
    );
  }
  if (candidate.type === "string") {
    if (typeof candidate.default !== "string") {
      issue(
        issues,
        `${path}.default`,
        "invalid-format",
        "String setting default must be a string.",
      );
    }
    if (candidate.sensitive !== undefined && typeof candidate.sensitive !== "boolean") {
      issue(issues, `${path}.sensitive`, "invalid-format", "sensitive must be a boolean.");
    }
    validateNumericRules(candidate.validation, path, issues, ["minLength", "maxLength"], true);
    if (isRecord(candidate.validation)) {
      const minimum = candidate.validation.minLength;
      const maximum = candidate.validation.maxLength;
      if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) {
        issue(issues, `${path}.validation`, "invalid-format", "minLength cannot exceed maxLength.");
      }
    }
  }
  if (candidate.type === "number") {
    if (typeof candidate.default !== "number" || !Number.isFinite(candidate.default)) {
      issue(issues, `${path}.default`, "invalid-format", "Number setting default must be finite.");
    }
    validateNumericRules(candidate.validation, path, issues, ["minimum", "maximum", "step"], false);
    if (isRecord(candidate.validation)) {
      const minimum = candidate.validation.minimum;
      const maximum = candidate.validation.maximum;
      if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) {
        issue(issues, `${path}.validation`, "invalid-format", "minimum cannot exceed maximum.");
      }
      if (typeof candidate.validation.step === "number" && candidate.validation.step <= 0) {
        issue(
          issues,
          `${path}.validation.step`,
          "invalid-format",
          "step must be greater than zero.",
        );
      }
    }
  }
  if (candidate.type === "select") {
    if (typeof candidate.default !== "string") {
      issue(
        issues,
        `${path}.default`,
        "invalid-format",
        "Select setting default must be a string.",
      );
    }
    if (!Array.isArray(candidate.options) || candidate.options.length === 0) {
      issue(issues, `${path}.options`, "missing", "Select settings must contain options.");
      return;
    }
    const options: Array<{ name: string; path: string }> = [];
    candidate.options.forEach((option, index) => {
      const optionPath = `${path}.options[${index}]`;
      if (!isRecord(option)) {
        issue(issues, optionPath, "invalid-format", `${optionPath} must be an object.`);
        return;
      }
      if (requireString(option.value, `${optionPath}.value`, issues)) {
        options.push({ name: option.value, path: `${optionPath}.value` });
      }
      requireString(option.label, `${optionPath}.label`, issues);
    });
    validateUniqueNames(options, issues);
    if (
      typeof candidate.default === "string" &&
      !candidate.options.some((option) => isRecord(option) && option.value === candidate.default)
    ) {
      issue(
        issues,
        `${path}.default`,
        "invalid-format",
        "Select setting default must match an option value.",
      );
    }
  }
}

function validateHandlerContributions(
  handlers: unknown,
  operations: unknown,
  issues: AppManifestValidationIssue[],
): void {
  if (handlers !== undefined) {
    if (!Array.isArray(handlers)) {
      issue(issues, "contributions.handlers", "invalid-format", "handlers must be an array.");
    } else {
      const intents: Array<{ name: string; path: string }> = [];
      const operationKeys = new Set(
        Array.isArray(operations)
          ? operations.flatMap((operation) =>
              isRecord(operation) && typeof operation.key === "string" ? [operation.key] : [],
            )
          : [],
      );
      handlers.forEach((candidate, index) => {
        const path = `contributions.handlers[${index}]`;
        if (!isRecord(candidate)) {
          issue(issues, path, "invalid-format", `${path} must be an object.`);
          return;
        }
        if (
          candidate.intent !== "open-url" &&
          candidate.intent !== "open-file" &&
          candidate.intent !== "open-directory"
        ) {
          issue(
            issues,
            `${path}.intent`,
            "invalid-format",
            "intent must be open-url, open-file, or open-directory.",
          );
          return;
        }
        intents.push({ name: candidate.intent, path: `${path}.intent` });
        if (
          requireString(candidate.operation, `${path}.operation`, issues) &&
          !operationKeys.has(candidate.operation)
        ) {
          issue(
            issues,
            `${path}.operation`,
            "invalid-format",
            "handler operation must reference a declared operation key.",
          );
        }
        if (candidate.intent === "open-url") {
          if (
            !Array.isArray(candidate.schemes) ||
            candidate.schemes.length === 0 ||
            candidate.schemes.some(
              (scheme) => typeof scheme !== "string" || !/^[a-z][a-z0-9+.-]*$/.test(scheme),
            )
          ) {
            issue(
              issues,
              `${path}.schemes`,
              "invalid-format",
              "open-url schemes must be a non-empty array of lowercase URL schemes.",
            );
          }
          if (candidate.extensions !== undefined) {
            issue(issues, path, "invalid-format", "open-url handlers cannot declare file filters.");
          }
        } else if (candidate.intent === "open-file") {
          const extensionsValid =
            Array.isArray(candidate.extensions) &&
            candidate.extensions.length > 0 &&
            candidate.extensions.every(
              (extension) =>
                typeof extension === "string" && /^\.[a-z0-9][a-z0-9._+-]*$/i.test(extension),
            );
          if (!extensionsValid) {
            issue(
              issues,
              path,
              "invalid-format",
              "open-file handlers require non-empty dot-prefixed extensions.",
            );
          }
          if (candidate.schemes !== undefined)
            issue(issues, path, "invalid-format", "open-file handlers cannot declare URL schemes.");
        } else if (candidate.schemes !== undefined || candidate.extensions !== undefined) {
          issue(
            issues,
            path,
            "invalid-format",
            "open-directory handlers cannot declare schemes or extensions.",
          );
        }
      });
      validateUniqueNames(intents, issues);
    }
  }
}

function validateNumericRules(
  value: unknown,
  path: string,
  issues: AppManifestValidationIssue[],
  allowed: readonly string[],
  integer: boolean,
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issue(issues, `${path}.validation`, "invalid-format", "validation must be an object.");
    return;
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (
      !allowed.includes(key) ||
      typeof candidate !== "number" ||
      !Number.isFinite(candidate) ||
      (integer && !Number.isInteger(candidate)) ||
      (integer && candidate < 0)
    ) {
      issue(
        issues,
        `${path}.validation.${key}`,
        "invalid-format",
        `${key} is not a valid validation rule.`,
      );
    }
  }
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
