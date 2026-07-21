import { readFile } from "node:fs/promises";

import {
  PenkraClientSummary,
  PenkraCreateClientResult as PenkraCreateClientResultSchema,
  PenkraProgramWarning,
  PenkraSkillSummary,
  PenkraTodoSummary as PenkraTodoSummarySchema,
  type PenkraCreateClientResult,
  PenkraCreateClientInput,
  PenkraCreateTodoInput,
  type PenkraGetInstructionsInput,
  type PenkraInstructionDocument,
  PenkraSnapshot,
  PenkraUpdateTodoInput,
  PenkraUpdateClientInput,
} from "@synara/contracts";
import { Schema } from "effect";

export type PenkraClientRecord = {
  id: string;
  displayName: string;
  status: "active" | "suspended" | "archived";
  instructions: string;
};

type PenkraRemoteSnapshot = Pick<
  PenkraSnapshot,
  "generatedAt" | "clients" | "todos" | "programWarnings" | "skills"
>;

const ClientRecordSchema = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  status: Schema.Literals(["active", "suspended", "archived"]),
  instructions: Schema.String,
});
const ClientPageSchema = Schema.Struct({
  items: Schema.Array(ClientRecordSchema),
  pageInfo: Schema.Struct({ nextCursor: Schema.NullOr(Schema.String) }),
});
const TokenResponseSchema = Schema.Struct({ token: Schema.String });
const TodoMutationResponseSchema = Schema.Struct({ id: Schema.String });
const InstructionDocumentSchema = Schema.Struct({
  scope: Schema.Literals(["hq", "client"]),
  body: Schema.String,
  revision: Schema.String,
  updatedAt: Schema.NullOr(Schema.String),
});
const RemoteSnapshotSchema = Schema.Struct({
  generatedAt: Schema.String,
  clients: Schema.Array(PenkraClientSummary),
  todos: Schema.Array(PenkraTodoSummarySchema),
  programWarnings: Schema.Array(PenkraProgramWarning),
  skills: Schema.optional(Schema.Array(PenkraSkillSummary)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
});
const decodeClientPage = Schema.decodeUnknownSync(ClientPageSchema);
const decodeTokenResponse = Schema.decodeUnknownSync(TokenResponseSchema);
const decodeRemoteSnapshot = Schema.decodeUnknownSync(RemoteSnapshotSchema);
const decodeCreateClient = Schema.decodeUnknownSync(PenkraCreateClientResultSchema);
const decodeTodoMutation = Schema.decodeUnknownSync(TodoMutationResponseSchema);
const decodeInstructionDocument = Schema.decodeUnknownSync(InstructionDocumentSchema);
const decodeClientRecord = Schema.decodeUnknownSync(ClientRecordSchema);

export class PenkraApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PenkraApiError";
  }
}

type HqConfig = {
  endpoint: string;
  scope: "hq";
  token: string;
};

export class PenkraBackendClient {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
  ) {}

  socketConnection(): { endpoint: string; token: string } {
    return { endpoint: this.endpoint, token: this.token };
  }

  static async fromHqConfig(path: string): Promise<PenkraBackendClient | null> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
    const value = JSON.parse(text) as Partial<HqConfig>;
    if (
      value.scope !== "hq" ||
      typeof value.endpoint !== "string" ||
      !value.endpoint.startsWith("http") ||
      typeof value.token !== "string" ||
      !value.token.startsWith("pk_hq_")
    ) {
      throw new Error(`Invalid Penkra HQ config at ${path}`);
    }
    return new PenkraBackendClient(value.endpoint.replace(/\/$/, ""), value.token);
  }

  async listClients(): Promise<PenkraClientRecord[]> {
    const clients: PenkraClientRecord[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ limit: "200" });
      if (cursor) params.set("cursor", cursor);
      const page = await this.request(`/api/clients?${params.toString()}`, decodeClientPage);
      clients.push(...page.items);
      cursor = page.pageInfo.nextCursor;
    } while (cursor);
    return clients;
  }

  async reissueClientToken(clientId: string): Promise<string> {
    const response = await this.request(
      `/api/clients/${encodeURIComponent(clientId)}/reissue-token`,
      decodeTokenResponse,
      { method: "POST", body: "{}" },
    );
    return response.token;
  }

  getClient(clientId: string): Promise<PenkraClientRecord> {
    return this.request(`/api/clients/${encodeURIComponent(clientId)}`, decodeClientRecord);
  }

  getSnapshot(): Promise<PenkraRemoteSnapshot> {
    return this.request("/api/app/snapshot", decodeRemoteSnapshot);
  }

  getInstructionDocument(
    scope: "hq" | "client",
  ): Promise<{ body: string; revision: string; updatedAt: string | null }> {
    return this.request(`/api/instructions/${scope}`, decodeInstructionDocument);
  }

  async getInstructions(input: PenkraGetInstructionsInput): Promise<PenkraInstructionDocument> {
    if (input.scope === "client-specific") {
      if (!input.clientId) throw new Error("clientId is required for client-specific instructions");
      const client = await this.getClient(input.clientId);
      return {
        scope: input.scope,
        clientId: client.id,
        body: client.instructions,
        revision: null,
        updatedAt: null,
      };
    }
    const document = await this.getInstructionDocument(input.scope);
    return { scope: input.scope, clientId: null, ...document };
  }

  createClient(input: PenkraCreateClientInput): Promise<PenkraCreateClientResult> {
    const { idempotencyKey, ...body } = input;
    return this.request("/api/clients", decodeCreateClient, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify(body),
    });
  }

  updateClient(input: PenkraUpdateClientInput): Promise<PenkraCreateClientResult> {
    return this.request(`/api/clients/${encodeURIComponent(input.clientId)}`, decodeCreateClient, {
      method: "PATCH",
      body: JSON.stringify({ instructions: input.instructions }),
    });
  }

  async createTodo(input: PenkraCreateTodoInput): Promise<string> {
    const { idempotencyKey, ...fields } = input;
    const todo = await this.request("/api/todos", decodeTodoMutation, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey },
      body: JSON.stringify({
        ...fields,
        source: "operator",
        kind: input.kind ?? "general",
        payload: input.payload ?? {},
        auto: false,
      }),
    });
    return todo.id;
  }

  async updateTodo(input: PenkraUpdateTodoInput): Promise<string> {
    const { todoId, ...body } = input;
    const todo = await this.request(
      `/api/todos/${encodeURIComponent(todoId)}`,
      decodeTodoMutation,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    );
    return todo.id;
  }

  private async request<T>(
    path: string,
    decode: (payload: unknown) => T,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(`${this.endpoint}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      const message =
        isRecord(payload) && typeof payload.message === "string"
          ? payload.message
          : `Penkra API returned HTTP ${response.status}`;
      throw new PenkraApiError(response.status, message);
    }
    return decode(payload);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
