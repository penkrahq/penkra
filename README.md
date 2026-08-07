# Penkra

**A desktop workspace for sustained, agentic work.**

![Penkra workspace with Spaces, threads, and the Apps panel](docs/readme-assets/DFDYE.png)

Penkra is a desktop environment where you run and organize multiple AI agent threads at once, connect them to purpose-built Apps, and keep control over what each App can access. It is not a chat wrapper, an IDE, or a terminal — it is a workspace built for working _with_ AI, not just talking to it.

## What Penkra does

Penkra lets you spin up multiple concurrent threads, each backed by an AI provider of your choice — Claude, Codex, Gemini, or others. Every thread lives in a **Space**, so you can keep different projects, clients, or research areas cleanly separated.

Each thread runs in the background. You can check in on progress, jump between threads, review output, or hand off follow-up instructions — all without losing context. Penkra handles reconnection, partial streams, and session recovery so your work stays reliable even when connections drop.

![An active Penkra thread with agent output and follow-up controls](docs/readme-assets/O9J2t.png)

### Spaces and organization

Your work is organized into **Spaces** and **Folders**:

- **Spaces** are top-level containers — think of them as separate desks for separate projects.
- **Folders** live inside Spaces and group related threads.
- **Threads** are individual agent sessions where the actual work happens.

You can create, rename, archive, and move things around freely. The structure adapts to how you work, not the other way around.

<p align="center">
  <img src="docs/readme-assets/i0zpy.png" alt="Penkra sidebar showing Spaces, folders, pinned threads, and running work" width="320" />
</p>

### Apps

Penkra has an Apps platform. Apps are small, self-contained web applications that run inside Penkra's right panel, each in its own isolated tab. They connect to your threads and can read, write, and act on your behalf — with explicit permissions you control.

Every new Space installs three Penkra-published Apps from the registry:

| App          | What it does                                           |
| ------------ | ------------------------------------------------------ |
| **Apps**     | Browse, install, and manage Apps from the registry     |
| **Browser**  | Browse the web in a scoped, agent-accessible session   |
| **Explorer** | Browse, search, preview, and open files on your system |

Third-party developers can build their own Apps using the public SDK. Every App runs in the same isolated environment — there are no hidden first-party privileges.

<p align="center">
  <img src="docs/readme-assets/DSDog.png" alt="Installed Apps in Penkra's right panel" width="32%" />
  <img src="docs/readme-assets/Gjw2I.png" alt="The Browser App displaying penkra.com" width="64%" />
</p>

### Provider agnostic

Penkra does not lock you into one AI provider. You bring the providers you want and Penkra handles the plumbing — threading, state, permissions, and session management — consistently across all of them.

### Built-in tools

Penkra includes tools that agent threads can use out of the box:

- **Terminal** — full terminal access via xterm.js with GPU rendering
- **File operations** — read, write, and search files with proper scoping
- **Git integration** — view diffs, stage changes, and commit
- **Voice notes** — record and transcribe audio directly in a thread
- **Scheduling** — set timers, cron jobs, and automation policies

## For developers

Penkra is built with Electron and React. If you want to contribute or run it locally:

### Prerequisites

- [Bun](https://bun.sh) (package manager)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (started automatically by the dev launcher)

### Getting started

```sh
# Install dependencies
bun install --frozen-lockfile

# Install the macOS development launcher
bun run dev:desktop:install-app
```

Open **Penkra Dev**, **Penkra Dev 2**, or **Penkra Dev 3** from `/Applications`. The first app starts Docker and the shared local services; each numbered app has its own login, local database, tabs, Threads, Chromium profile, and logs. Closing one app leaves the others running, and the shared services stop after the last app closes.

The default installer provisions slots 1–3 without imposing a maximum. Install another stable slot with `bun run dev:desktop:install-app -- 4`; after that, **Penkra Dev 4** launches normally from Applications.

### Tech stack

| Layer         | Technology                               |
| ------------- | ---------------------------------------- |
| Desktop shell | Electron                                 |
| UI            | React 19, Vite, Tailwind CSS 4           |
| State         | Zustand                                  |
| Routing       | Tanstack Router                          |
| Rich text     | Lexical, Markdown (remark/rehype), KaTeX |
| Terminal      | xterm.js (WebGL)                         |
| Animation     | Motion                                   |
| Testing       | Vitest, Playwright, Storybook            |
| Monorepo      | Turborepo, Bun workspaces                |
| Language      | TypeScript, Effect-TS                    |

### Repository structure

```text
penkra/
├── apps/
│   ├── desktop/       # Electron lifecycle, native integration, IPC, updates
│   ├── web/           # React/Vite UI — session UX, conversation rendering, state
│   ├── server/        # Local server, provider harnesses, threads, filesystem
│   └── marketing/     # Marketing landing page
├── packages/
│   ├── contracts/     # Shared schemas — WebSocket protocol, events, models
│   ├── shared/        # Reusable runtime and domain utilities
│   ├── sdk/           # Public SDK for App developers
│   └── ui/            # Semantic tokens, CSS, icons, framework-neutral primitives
├── examples/
│   └── sample-app/    # Framework-neutral example App
└── docs/
    └── app-development.md  # App development guide
```

### Design system

Penkra's visual design is authored in [Pencil](https://pencil.app) (`penkra.pen`). Pencil is the source of truth for component hierarchy, states, and visual composition. React components in the codebase reproduce that design while retaining production routing, state management, accessibility, and desktop behavior.

### Component library

Run the Storybook component library to browse and develop UI components in isolation:

```sh
bun run --cwd apps/web storybook
```

### Environment variables

Source builds use Penkra's production account services by default. For internal development, set both `PENKRA_API_URL` and `PENKRA_WEBSITE_ORIGIN` to your local backend and website. See `.env.example` for the full list.

### Running tests

```sh
bun run test
```

This runs the test task in each workspace package. It does not cross into `penkra-website` or `penkra-backend`.
