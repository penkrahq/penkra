// FILE: localModelService.ts
// Purpose: The Local provider's on-device side, in one place:
//  - a loopback OpenAI-compatible proxy that OpenCode talks to (stable URL for
//    the server's lifetime, whichever model is loaded behind it);
//  - model downloads with progress for the picker;
//  - request rules the runtime needs: always cap max_tokens, restart the model
//    server once when it dies mid-request.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";

import {
  LOCAL_MODEL_CATALOG,
  findLocalModel,
  localModelAvailability,
  localModelForMachine,
  type LocalModelEntry,
} from "./localModelCatalog.ts";
import {
  downloadLocalModel,
  isLocalModelDownloaded,
  localModelDirectory,
  type LocalModelDownloadProgress,
} from "./localModelDownloads.ts";
import { installLocalRuntime } from "./localModelRuntime.ts";
import { LocalModelSupervisor } from "./localModelSupervisor.ts";
import { RepetitionGuard } from "./repetitionGuard.ts";

export type LocalModelDownloadState =
  | { readonly kind: "idle" }
  | { readonly kind: "downloading"; readonly progress: LocalModelDownloadProgress }
  | { readonly kind: "failed"; readonly message: string };

export interface LocalModelListing {
  readonly entry: LocalModelEntry;
  readonly downloaded: boolean;
  readonly unavailableReason: string | null;
  readonly download: LocalModelDownloadState;
}

export interface LocalModelServiceOptions {
  readonly stateDir: string;
  readonly totalMemoryBytes?: number;
  readonly supervisor?: LocalModelSupervisor;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (message: string) => void;
}

export class LocalModelService {
  readonly #stateDir: string;
  readonly #totalMemoryBytes: number;
  readonly #supervisor: LocalModelSupervisor;
  readonly #fetch: typeof fetch;
  readonly #log: (message: string) => void;
  readonly #warming = new Map<string, Promise<void>>();
  readonly #lastPrefix = new Map<string, string>();
  readonly #downloads = new Map<string, { state: LocalModelDownloadState; abort: AbortController | null }>();
  readonly #listeners = new Set<() => void>();
  readonly #downloadRuns = new Map<string, Promise<void>>();
  #server: Server | null = null;
  #baseUrl: Promise<string> | null = null;

  constructor(options: LocalModelServiceOptions) {
    this.#stateDir = options.stateDir;
    this.#totalMemoryBytes = options.totalMemoryBytes ?? os.totalmem();
    this.#log = options.log ?? (() => {});
    this.#supervisor = options.supervisor ?? new LocalModelSupervisor({ log: this.#log });
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** The catalog as it applies to this Mac (context caps scale with memory). */
  catalog(): LocalModelEntry[] {
    return LOCAL_MODEL_CATALOG.map((entry) => localModelForMachine(entry, this.#totalMemoryBytes));
  }

  async list(): Promise<LocalModelListing[]> {
    return Promise.all(
      this.catalog().map(async (entry) => {
        const availability = localModelAvailability(entry, this.#totalMemoryBytes);
        return {
          entry,
          downloaded: await isLocalModelDownloaded(this.#stateDir, entry),
          unavailableReason: availability.kind === "available" ? null : availability.reason,
          download: this.#downloads.get(entry.id)?.state ?? { kind: "idle" },
        };
      }),
    );
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Starts (or joins) a download. Resolves when the model is ready to run. */
  download(modelId: string): Promise<void> {
    const running = this.#downloadRuns.get(modelId);
    if (running) return running;
    const run = this.#download(modelId).finally(() => this.#downloadRuns.delete(modelId));
    this.#downloadRuns.set(modelId, run);
    return run;
  }

  async #download(modelId: string): Promise<void> {
    const entry = this.#requireRunnable(modelId);
    const abort = new AbortController();
    const set = (state: LocalModelDownloadState) => {
      this.#downloads.set(modelId, { state, abort: state.kind === "downloading" ? abort : null });
      for (const listener of this.#listeners) listener();
    };
    set({ kind: "downloading", progress: { receivedBytes: 0, totalBytes: entry.downloadGb * 1024 ** 3 } });
    let lastEmit = 0;
    try {
      await installLocalRuntime({ stateDir: this.#stateDir, fetchImpl: this.#fetch });
      await downloadLocalModel({
        stateDir: this.#stateDir,
        entry,
        signal: abort.signal,
        fetchImpl: this.#fetch,
        onProgress: (progress) => {
          if (Date.now() - lastEmit < 250 && progress.receivedBytes < progress.totalBytes) return;
          lastEmit = Date.now();
          set({ kind: "downloading", progress });
        },
      });
      set({ kind: "idle" });
    } catch (cause) {
      const message = abort.signal.aborted ? "Download cancelled." : (cause as Error).message;
      set({ kind: "failed", message });
      throw cause;
    }
  }

  cancelDownload(modelId: string): void {
    this.#downloads.get(modelId)?.abort?.abort();
  }

  /**
   * Loads the model and runs the agent's last fixed prompt (system message and
   * tools) through it once, so the runtime's prompt cache already holds it.
   * Reading OpenCode's ~10k-token prompt takes ~40 s cold on an M1 Max.
   */
  async warm(modelId: string): Promise<void> {
    const entry = this.#requireRunnable(modelId);
    if (!(await isLocalModelDownloaded(this.#stateDir, entry))) return;
    if (this.#warming.has(entry.id)) return this.#warming.get(entry.id);
    const run = (async () => {
      let prefix: Record<string, unknown>;
      try {
        prefix = JSON.parse(await readFile(this.#prefixPath(entry.id), "utf8"));
      } catch {
        return; // No agent turn yet; nothing to pre-read.
      }
      const base = await this.#supervisor.ensure({
        modelId: entry.id,
        pythonPath: (await installLocalRuntime({ stateDir: this.#stateDir, fetchImpl: this.#fetch }))
          .pythonPath,
        modelPath: localModelDirectory(this.#stateDir, entry),
      });
      const started = Date.now();
      const r = await this.#fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...prefix,
          model: localModelDirectory(this.#stateDir, entry),
          messages: [...(prefix.messages as unknown[]), { role: "user", content: "." }],
          max_tokens: 1,
          stream: false,
        }),
      });
      await r.arrayBuffer();
      this.#log(`${entry.id}: warmed in ${Date.now() - started}ms`);
    })().finally(() => this.#warming.delete(entry.id));
    this.#warming.set(entry.id, run);
    return run;
  }

  #prefixPath(modelId: string): string {
    return join(this.#stateDir, "local-models", "prompt-prefix", `${modelId}.json`);
  }

  async #rememberPromptPrefix(modelId: string, request: Record<string, unknown>): Promise<void> {
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const first = messages[0] as { role?: unknown } | undefined;
    if (first?.role !== "system") return;
    const prefix = JSON.stringify({
      messages: [first],
      ...(request.tools ? { tools: request.tools } : {}),
      ...(request.tool_choice ? { tool_choice: request.tool_choice } : {}),
    });
    if (this.#lastPrefix.get(modelId) === prefix) return;
    this.#lastPrefix.set(modelId, prefix);
    try {
      await mkdir(dirname(this.#prefixPath(modelId)), { recursive: true });
      await writeFile(this.#prefixPath(modelId), prefix);
    } catch (cause) {
      this.#log(`could not save the prompt prefix: ${(cause as Error).message}`);
    }
  }

  /** Loopback base URL ("http://127.0.0.1:port/v1") for OpenCode's provider config. */
  proxyBaseUrl(): Promise<string> {
    this.#baseUrl ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.#handle(req, res));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address !== "object" || !address) return reject(new Error("no address"));
        this.#server = server;
        resolve(`http://127.0.0.1:${address.port}/v1`);
      });
    });
    return this.#baseUrl;
  }

  async close(): Promise<void> {
    for (const { abort } of this.#downloads.values()) abort?.abort();
    await this.#supervisor.stop();
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  #requireRunnable(modelId: string): LocalModelEntry {
    const entry = findLocalModel(modelId);
    if (!entry) throw new Error(`Unknown local model ${modelId}.`);
    const availability = localModelAvailability(entry, this.#totalMemoryBytes);
    if (availability.kind !== "available") throw new Error(availability.reason);
    return entry;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === "GET" && req.url === "/v1/models") {
        return json(res, 200, {
          object: "list",
          data: LOCAL_MODEL_CATALOG.map((m) => ({ id: m.id, object: "model", owned_by: "penkra" })),
        });
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") return json(res, 404, error("Not found."));
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const entry = this.#requireRunnable(String(body.model));
      if (!(await isLocalModelDownloaded(this.#stateDir, entry))) {
        // A turn sent before the model is on disk waits for it (starting the
        // download if the picker didn't), rather than failing.
        this.#log(`${entry.id}: turn waiting for download`);
        try {
          await this.download(entry.id);
        } catch (cause) {
          return json(res, 503, error(`${entry.label} couldn't be downloaded. ${(cause as Error).message}`));
        }
      }
      const requested = typeof body.max_tokens === "number" ? body.max_tokens : entry.maxOutputTokens;
      const outgoing: Record<string, unknown> = {
        ...body,
        ...(Array.isArray(body.messages)
          ? { messages: moveEnvironmentToUser(presentAsPenkra(mergeSystemMessages(body.messages))) }
          : {}),
        model: localModelDirectory(this.#stateDir, entry),
        // mlx_lm.server silently defaults to 512 output tokens.
        max_tokens: Math.min(requested, entry.maxOutputTokens),
      };
      const spec = {
        modelId: entry.id,
        pythonPath: (await installLocalRuntime({ stateDir: this.#stateDir, fetchImpl: this.#fetch })).pythonPath,
        modelPath: localModelDirectory(this.#stateDir, entry),
      };
      const send = async (payload: Record<string, unknown>, signal?: AbortSignal) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const base = await this.#supervisor.ensure(spec);
          try {
            const r = await this.#fetch(`${base}/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
              ...(signal ? { signal } : {}),
            });
            // A dead generation thread answers 404 to everything; restart once.
            if (r.status === 404 && attempt === 0) {
              this.#supervisor.reportFailure(entry.id);
              continue;
            }
            return r;
          } catch (cause) {
            if (signal?.aborted) throw cause;
            this.#supervisor.reportFailure(entry.id);
            if (attempt === 1) throw cause;
          }
        }
        return null;
      };
      void this.#rememberPromptPrefix(entry.id, outgoing);
      const abort = new AbortController();
      const t0 = Date.now();
      const upstream = await send(outgoing, abort.signal);
      if (!upstream) return json(res, 502, error(`${entry.label} stopped responding.`));
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      if (!upstream.body) return void res.end();
      if (body.stream !== true || !upstream.ok) {
        for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
        return void res.end();
      }
      const outcome = await forwardThinkingWithBudget(
        upstream.body as unknown as AsyncIterable<Uint8Array>,
        (line) => res.write(line),
        entry.thinkingBudgetChars,
      );
      if (outcome === "looping") abort.abort();
      if (outcome === "over-budget") {
        // Small models can think for minutes on trivial prompts. Stop the
        // thought and answer directly, streaming into the same response.
        abort.abort();
        const direct = await send({
          ...outgoing,
          chat_template_kwargs: {
            ...(outgoing.chat_template_kwargs as Record<string, unknown> | undefined),
            enable_thinking: false,
          },
        });
        if (direct?.ok && direct.body) {
          for await (const chunk of direct.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
        }
      }
      this.#log(`${entry.id}: turn ${Date.now() - t0}ms${outcome === "done" ? "" : outcome === "looping" ? ", stopped a repetition loop" : ", thinking cut off"}`);
      res.end();
    } catch (cause) {
      this.#log(`local model proxy: ${(cause as Error).message}`);
      if (!res.headersSent) json(res, 500, error((cause as Error).message));
      else res.end();
    }
  }
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

const error = (message: string) => ({ error: { message, type: "local_model_error" } });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

type ChatMessage = { role?: unknown; content?: unknown };

/**
 * Qwen chat templates reject any system message that is not the very first
 * message; OpenCode sends several. Fold them all into one leading message.
 */
export function mergeSystemMessages(messages: ReadonlyArray<unknown>): unknown[] {
  const system: string[] = [];
  const rest: unknown[] = [];
  for (const message of messages) {
    const m = message as ChatMessage;
    if (m?.role !== "system") {
      rest.push(message);
      continue;
    }
    if (typeof m.content === "string") system.push(m.content);
    else if (Array.isArray(m.content))
      system.push(
        m.content
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .filter(Boolean)
          .join("\n"),
      );
  }
  return system.length === 0 ? rest : [{ role: "system", content: system.join("\n\n") }, ...rest];
}

/**
 * Forwards an SSE chat stream line by line. Stops without forwarding the rest
 * once the streamed reasoning passes `budgetChars` ("over-budget"), or once the
 * model is repeating itself ("looping").
 */
export async function forwardThinkingWithBudget(
  stream: AsyncIterable<Uint8Array>,
  write: (line: string) => void,
  budgetChars: number,
): Promise<"done" | "over-budget" | "looping"> {
  const decoder = new TextDecoder();
  const guard = new RepetitionGuard();
  let buffer = "";
  let reasoningChars = 0;
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline + 1);
      buffer = buffer.slice(newline + 1);
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      let looping = false;
      if (data && data !== "[DONE]") {
        try {
          const delta = JSON.parse(data)?.choices?.[0]?.delta;
          const reasoning = delta?.reasoning ?? delta?.reasoning_content;
          if (typeof reasoning === "string") reasoningChars += reasoning.length;
          const args = (delta?.tool_calls ?? []).map((c: { function?: { arguments?: string } }) => c.function?.arguments ?? "");
          for (const text of [reasoning, delta?.content, ...args]) {
            if (typeof text === "string" && guard.push(text)) looping = true;
          }
        } catch {
          // Not JSON; forward as-is.
        }
      }
      if (looping) {
        // End the turn the way a token limit would, so the harness stops cleanly.
        write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}\n\n`);
        write("data: [DONE]\n\n");
        return "looping";
      }
      write(line);
      if (reasoningChars > budgetChars) return "over-budget";
    }
  }
  if (buffer) write(buffer);
  return "done";
}

const ENVIRONMENT_BLOCK = /<env>[\s\S]*?<\/env>\n?/;

/**
 * OpenCode's system prompt embeds each thread's working directory in an
 * <env> block. Everything after it (most of the prompt, and all tool
 * definitions) then differs per thread and misses the runtime's prompt cache.
 * Moving the block to the first user message keeps the long prefix shared.
 */
const OPENCODE_IDENTITY = /^You are opencode, an interactive CLI tool that helps users with software engineering tasks\./;
const OPENCODE_HELP_BLOCK =
  /If the user asks for help or wants to give feedback inform them of the following:\n(?:- .*\n)+\n?/;
const OPENCODE_SELF_QUESTIONS = /When the user directly asks about opencode[^\n]*\n\n?/;

/**
 * Local runs on OpenCode underneath, and OpenCode's system prompt introduces the
 * model as "opencode" and sends questions about itself to opencode.ai. In
 * Penkra the user picked a model on their Mac, so say that instead.
 */
export function presentAsPenkra(messages: ReadonlyArray<unknown>): unknown[] {
  const [first, ...rest] = messages as ChatMessage[];
  if (first?.role !== "system" || typeof first.content !== "string") return [...messages];
  const content = first.content
    .replace(
      OPENCODE_IDENTITY,
      "You are an AI assistant in Penkra, running entirely on this Mac. You help with software engineering and other tasks.",
    )
    .replace(OPENCODE_HELP_BLOCK, "")
    .replace(OPENCODE_SELF_QUESTIONS, "");
  return [{ ...first, content }, ...rest];
}

export function moveEnvironmentToUser(messages: ReadonlyArray<unknown>): unknown[] {
  const [first, ...rest] = messages as ChatMessage[];
  if (first?.role !== "system" || typeof first.content !== "string") return [...messages];
  const match = ENVIRONMENT_BLOCK.exec(first.content);
  const userIndex = rest.findIndex((m) => m?.role === "user");
  if (!match || userIndex < 0) return [...messages];
  const environment = match[0].trimEnd();
  const user = rest[userIndex]!;
  const content =
    typeof user.content === "string"
      ? `${environment}\n\n${user.content}`
      : Array.isArray(user.content)
        ? [{ type: "text", text: environment }, ...user.content]
        : null;
  if (content === null) return [...messages];
  const moved = [...rest];
  moved[userIndex] = { ...user, content };
  return [{ ...first, content: first.content.replace(ENVIRONMENT_BLOCK, "") }, ...moved];
}
