import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

import type { PenkraClientRecord } from "./backendClient";

const CLIENT_AGENTS = `# Penkra Client Workspace

This folder belongs to one Penkra client. Work only within this client's scope.

- Use \`penkra\` for todos, structured client data, skills, and objects.
- Run \`penkra whoami\` before consequential work if scope is uncertain.
- Load referenced skills with \`penkra skill load <name>\` and follow them exactly.
- Never improvise external effects. When human action is required, create or block a todo with a clear reason.
- Do not read, copy, or infer data from another client workspace.
`;

const HQ_AGENTS = `# Penkra HQ Workspace

This is the operator's cross-client Penkra workspace.

- Use \`penkra\` for registry, todo, schema, skill, program, partner, and dispatch operations.
- Cross-client access is intentional here; verify the target client before mutating data.
- Apply database changes through the local \`skills/db-migration.md\` procedure.
- Never perform an external effect unless the operator explicitly directs it.
`;

const HQ_SKILLS: Record<string, string> = {
  "db-migration.md": `# Database Migration

1. Inspect the live schema with \`penkra db schema\`.
2. Back up before destructive DDL.
3. Prefer additive changes, backfill, and defer drops or renames to a later pass.
4. Add a \`COMMENT ON\` statement for every new column.
5. For every new \`client.*\` table, create the table, enable and force RLS, add client and HQ policies, verify both flags, and grant client DML last in one transaction.
6. Search and update every skill that references the changed schema.
7. Re-run the real Postgres security boundary suite.
`,
  "skill-authoring.md": `# Skill Authoring

Write operational instructions with a clear trigger, required inputs, ordered procedure, failure behavior, and completion criteria. Keep durable client facts in typed database columns, not free-form JSON. A skill must block and explain uncertainty rather than inventing facts or performing unapproved external effects.
`,
  "kind-management.md": `# Kind Management

Create a kind only for a repeatable class of work. Give it a precise description, route it to the narrowest applicable skill, choose agent or human execution deliberately, and set provider/model defaults only when the workflow has a demonstrated need.
`,
};

export async function scaffoldClient(input: {
  root: string;
  endpoint: string;
  client: PenkraClientRecord;
  token: string | null;
}): Promise<string> {
  const workspace = path.join(input.root, input.client.id);
  const configPath = path.join(workspace, ".penkra", "config.json");
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(configPath), 0o700);
  if (input.token) {
    await writeAtomic(
      configPath,
      `${JSON.stringify(
        {
          endpoint: input.endpoint,
          scope: "client",
          clientId: input.client.id,
          token: input.token,
          displayName: input.client.displayName,
        },
        null,
        2,
      )}\n`,
      0o600,
    );
  }
  await writeAtomic(path.join(workspace, "AGENTS.md"), CLIENT_AGENTS, 0o600);
  return workspace;
}

export async function scaffoldHq(root: string): Promise<string> {
  const workspace = path.join(root, "hq");
  await mkdir(path.join(workspace, "skills"), { recursive: true, mode: 0o700 });
  await writeAtomic(path.join(workspace, "AGENTS.md"), HQ_AGENTS, 0o600);
  for (const [name, body] of Object.entries(HQ_SKILLS)) {
    await writeAtomic(path.join(workspace, "skills", name), body, 0o600);
  }
  return workspace;
}

export async function hasClientConfig(workspace: string, clientId: string): Promise<boolean> {
  const configPath = path.join(workspace, ".penkra", "config.json");
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
  const config = JSON.parse(text) as Record<string, unknown>;
  if (
    config.scope !== "client" ||
    config.clientId !== clientId ||
    typeof config.token !== "string"
  ) {
    throw new Error(`Invalid client config at ${configPath}`);
  }
  return true;
}

async function writeAtomic(filePath: string, contents: string, mode: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    mode,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
  await chmod(filePath, mode);
  const directory = await open(path.dirname(filePath), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
