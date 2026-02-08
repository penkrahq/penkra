import {
  type Dispatch,
  type ReactNode,
  createContext,
  createElement,
  useContext,
  useEffect,
  useReducer,
} from "react";

import type { ProviderEvent, ProviderSession } from "@acme/contracts";
import { applyEventToMessages, evolveSession } from "./session-logic";
import type { Project, Thread } from "./types";

// ── Actions ──────────────────────────────────────────────────────────

type Action =
  | { type: "ADD_PROJECT"; project: Project }
  | { type: "TOGGLE_PROJECT"; projectId: string }
  | { type: "ADD_THREAD"; thread: Thread }
  | { type: "SET_ACTIVE_THREAD"; threadId: string }
  | { type: "TOGGLE_DIFF" }
  | {
      type: "APPLY_EVENT";
      event: ProviderEvent;
      activeAssistantItemRef: { current: string | null };
    }
  | { type: "UPDATE_SESSION"; threadId: string; session: ProviderSession }
  | { type: "PUSH_USER_MESSAGE"; threadId: string; id: string; text: string }
  | { type: "SET_ERROR"; threadId: string; error: string | null }
  | { type: "SET_THREAD_TITLE"; threadId: string; title: string }
  | { type: "SET_THREAD_MODEL"; threadId: string; model: string };

// ── State ────────────────────────────────────────────────────────────

export interface AppState {
  projects: Project[];
  threads: Thread[];
  activeThreadId: string | null;
  diffOpen: boolean;
}

const PERSISTED_STATE_KEY = "codething:renderer-state:v1";

const initialState: AppState = {
  projects: [],
  threads: [],
  activeThreadId: null,
  diffOpen: false,
};

// ── Helpers ──────────────────────────────────────────────────────────

interface PersistedStateV1 {
  projects: Project[];
  threads: Array<
    Pick<
      Thread,
      "id" | "projectId" | "title" | "model" | "messages" | "createdAt"
    >
  >;
  activeThreadId: string | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function sanitizeProjects(input: unknown): Project[] {
  if (!Array.isArray(input)) return [];

  return input
    .map((raw) => {
      const project = asObject(raw);
      if (!project) return null;

      const id = asString(project.id);
      const name = asString(project.name);
      const cwd = asString(project.cwd);
      const model = asString(project.model);
      const expanded = project.expanded;
      if (!id || !name || !cwd || !model || !isBoolean(expanded)) return null;

      return {
        id,
        name,
        cwd,
        model,
        expanded,
      } satisfies Project;
    })
    .filter((project): project is Project => project !== null);
}

function sanitizeMessages(input: unknown): Thread["messages"] {
  if (!Array.isArray(input)) return [];

  return input
    .map((raw) => {
      const message = asObject(raw);
      if (!message) return null;

      const id = asString(message.id);
      const role = message.role;
      const text = asString(message.text);
      const createdAt = asString(message.createdAt);
      const streaming = message.streaming;
      if (
        !id ||
        (role !== "user" && role !== "assistant") ||
        text === null ||
        !createdAt ||
        !isBoolean(streaming)
      ) {
        return null;
      }

      const hydratedMessage: Thread["messages"][number] = {
        id,
        role,
        text,
        createdAt,
        streaming: false,
      };
      return hydratedMessage;
    })
    .filter(
      (message): message is Thread["messages"][number] => message !== null,
    );
}

function sanitizeThreads(input: unknown): AppState["threads"] {
  if (!Array.isArray(input)) return [];

  return input
    .map((raw) => {
      const thread = asObject(raw);
      if (!thread) return null;

      const id = asString(thread.id);
      const projectId = asString(thread.projectId);
      const title = asString(thread.title);
      const model = asString(thread.model);
      const createdAt = asString(thread.createdAt);
      if (!id || !projectId || !title || !model || !createdAt) return null;

      const hydratedThread: Thread = {
        id,
        projectId,
        title,
        model,
        session: null,
        messages: sanitizeMessages(thread.messages),
        events: [],
        error: null,
        createdAt,
      };
      return hydratedThread;
    })
    .filter((thread): thread is Thread => thread !== null);
}

function readPersistedState(): AppState {
  if (typeof window === "undefined") return initialState;

  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) return initialState;

    const parsed = asObject(JSON.parse(raw));
    if (!parsed) return initialState;

    const projects = sanitizeProjects(parsed.projects);
    const projectIds = new Set(projects.map((project) => project.id));
    const threads = sanitizeThreads(parsed.threads).filter((thread) =>
      projectIds.has(thread.projectId),
    );
    const activeThreadId = asString(parsed.activeThreadId);
    const hasActiveThread = Boolean(
      activeThreadId && threads.some((thread) => thread.id === activeThreadId),
    );

    return {
      projects,
      threads,
      activeThreadId: hasActiveThread
        ? activeThreadId
        : threads[0]?.id
          ? threads[0].id
          : null,
      diffOpen: false,
    };
  } catch {
    return initialState;
  }
}

function toPersistedState(state: AppState): PersistedStateV1 {
  return {
    projects: state.projects,
    threads: state.threads.map((thread) => ({
      id: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      model: thread.model,
      messages: thread.messages,
      createdAt: thread.createdAt,
    })),
    activeThreadId: state.activeThreadId,
  };
}

function persistState(state: AppState): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify(toPersistedState(state)),
    );
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

function updateThread(
  threads: Thread[],
  threadId: string,
  updater: (t: Thread) => Thread,
): Thread[] {
  return threads.map((t) => (t.id === threadId ? updater(t) : t));
}

function findThreadBySessionId(
  threads: Thread[],
  sessionId: string,
): Thread | undefined {
  return threads.find((t) => t.session?.sessionId === sessionId);
}

// ── Reducer ──────────────────────────────────────────────────────────

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "ADD_PROJECT":
      return { ...state, projects: [...state.projects, action.project] };

    case "TOGGLE_PROJECT":
      return {
        ...state,
        projects: state.projects.map((p) =>
          p.id === action.projectId ? { ...p, expanded: !p.expanded } : p,
        ),
      };

    case "ADD_THREAD":
      return {
        ...state,
        threads: [...state.threads, action.thread],
        activeThreadId: action.thread.id,
      };

    case "SET_ACTIVE_THREAD":
      return { ...state, activeThreadId: action.threadId };

    case "TOGGLE_DIFF":
      return { ...state, diffOpen: !state.diffOpen };

    case "APPLY_EVENT": {
      const { event, activeAssistantItemRef } = action;
      const target = findThreadBySessionId(state.threads, event.sessionId);
      if (!target) return state;

      return {
        ...state,
        threads: updateThread(state.threads, target.id, (t) => ({
          ...t,
          session: t.session ? evolveSession(t.session, event) : t.session,
          messages: applyEventToMessages(
            t.messages,
            event,
            activeAssistantItemRef,
          ),
          events: [event, ...t.events].slice(0, 200),
          error:
            event.kind === "error" && event.message ? event.message : t.error,
        })),
      };
    }

    case "UPDATE_SESSION":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          session: action.session,
          events: [],
          error: null,
        })),
      };

    case "PUSH_USER_MESSAGE":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          messages: [
            ...t.messages,
            {
              id: action.id,
              role: "user" as const,
              text: action.text,
              createdAt: new Date().toISOString(),
              streaming: false,
            },
          ],
        })),
      };

    case "SET_ERROR":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          error: action.error,
        })),
      };

    case "SET_THREAD_TITLE":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          title: action.title,
        })),
      };

    case "SET_THREAD_MODEL":
      return {
        ...state,
        threads: updateThread(state.threads, action.threadId, (t) => ({
          ...t,
          model: action.model,
        })),
      };

    default:
      return state;
  }
}

// ── Context ──────────────────────────────────────────────────────────

const StoreContext = createContext<{
  state: AppState;
  dispatch: Dispatch<Action>;
}>({ state: initialState, dispatch: () => {} });

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, readPersistedState);

  useEffect(() => {
    persistState(state);
  }, [state]);

  return createElement(
    StoreContext.Provider,
    { value: { state, dispatch } },
    children,
  );
}

export function useStore() {
  return useContext(StoreContext);
}
