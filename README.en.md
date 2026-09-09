<div align="center">

# Deva

**AI-Native Development Workbench for Developers**

A desktop AI Agent application that combines the intelligent capabilities of Claude Code (file reading/writing, permission control, Skills, MCP, sub-Agents) with the professional tooling of IntelliJ IDEA (workspaces, Git, MySQL/Redis, terminal, SSH). The interface is modeled after Codex with design references from IDEA 2026.

[Documentation](./docs/README.md) · [Product Requirements](./docs/product/PRD.md) · [Architecture Design](./docs/architecture/overview.md) · [Roadmap](./docs/product/roadmap.md)

</div>

---

> ⚠️ **Project Status: Documentation Design Phase (Pre-Alpha).** The current repository primarily contains design documentation, and code implementation has not yet begun. Directories, modules, and dependencies mentioned in the documentation are **design specifications** and may be adjusted as implementation progresses.

## What is Deva

Deva is a desktop application that combines "AI coding agents" with "professional IDE tooling" into one unified experience. It's designed for developers and attempts to answer this question:

> When an AI Agent becomes a first-class citizen in the development workflow, what should the IDE built around it look like?

- Like **Claude Code**: equipped with an Agent that can read/write code, execute commands, and invoke tools with **fine-grained permission control**, extensible **Skills**, support for **MCP** services, and **sub-Agent** orchestration.
- Like **Codex**: a clean interface centered on conversational Agent workflows, task-driven, visual diffs, and full traceability.
- Like **IntelliJ IDEA**: built-in workspace management, Git integration, database clients (MySQL / Redis), integrated terminal, remote SSH connections, and other professional tool windows.

## Core Capabilities Overview

| Domain | Capabilities |
| --- | --- |
| **AI Agent** | Multi-provider abstraction (Claude / OpenAI / Ollama / OpenAI-compatible protocols), tool invocation loops, context management, task traceability |
| **Permission Control** | Tool-level / path-level / command-level permissions, Ask / Allow / Deny tri-state, session and project scopes |
| **Extensibility** | Skill system, MCP client support (stdio / SSE / HTTP), sub-Agent orchestration |
| **Code & Files** | Code editor, file tree, read/write with diffs, search capabilities |
| **Workspace** | Multi-workspace/project management, recent files, project-level configuration |
| **Version Control** | Git status, staging, commits, branches, diffs, history, conflict resolution |
| **Database** | MySQL and Redis connections, queries, result browsing and editing |
| **Terminal & Remote** | Integrated terminal (PTY), SSH remote connections, remote commands and file operations |
| **UI/UX** | Codex-inspired main layout + IDEA-style tool windows, theme switching (system-aware by default), i18n multilingual support |

> See [Product Requirements Document (PRD)](./docs/product/PRD.md) for details.

## Technology Stack

- **Desktop Framework**: [Electron](https://www.electronjs.org/) (multi-process: Main / Renderer / Utility)
- **Frontend**: React + TypeScript + Vite
- **Project Structure**: pnpm monorepo (`apps/` + `packages/`)
- **AI**: Custom Agent engine + multi-provider adapter layer
- **Key Native Capabilities**: `node-pty` (terminal), `ssh2` (SSH), `mysql2` (MySQL), `ioredis` (Redis), `simple-git` / `isomorphic-git` (Git)
- **Target Platforms**: Windows first, architecture compatible with macOS / Linux

> Detailed rationale for technology choices can be found in [Technology Stack Decisions](./docs/architecture/tech-stack.md).

## Documentation Map

Complete documentation index available in **[docs/README.md](./docs/README.md)**. Quick links:

- 🧭 [Product Requirements Document (PRD)](./docs/product/PRD.md) — Vision, user personas, feature scope, competitive analysis
- 🗺️ [Roadmap](./docs/product/roadmap.md) — Milestones and MVP scope
- 🏛️ [Architecture Overview](./docs/architecture/overview.md) — Process model, module division, data flow
- 🔐 [Security Model](./docs/architecture/security.md) — IPC, process isolation, permissions, and key management
- 🤖 [Agent Engine](./docs/modules/agent-engine.md) — Agent loop, tools, sub-Agents
- 🧩 [Skills & MCP](./docs/modules/skills-and-mcp.md)
- 🛠️ [IDE Features](./docs/modules/ide-features.md) — Workspaces, Git, terminal, SSH, database
- 🎨 [UI / Theming / Multilingual](./docs/modules/ui-theming-i18n.md)

## Development (Planned)

> The following commands represent the **target state**; the actual scaffolding is not yet in place.

```bash
pnpm install          # Install dependencies
pnpm dev              # Start development environment (Electron + Vite HMR)
pnpm build            # Build artifacts
pnpm package          # Package as distributable installer
pnpm test             # Run tests
pnpm lint             # Code linting
```

Engineering standards are outlined in [Coding Standards](./docs/engineering/coding-standards.md) and [Build & Release](./docs/engineering/build-release.md).

## License

[MIT](./LICENSE) © 2026 sqfcy
