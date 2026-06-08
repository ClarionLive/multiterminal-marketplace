# MultiTerminal Marketplace

A [Claude Code](https://claude.com/claude-code) plugin marketplace hosting **MultiTerminal** — a multi-agent coordination system for Claude Code. It provides hooks, skills, and agents for kanban task management, review pipelines, team orchestration, and session lifecycle tracking.

## Install

Add the marketplace, then install the plugin:

```bash
claude plugin marketplace add ClarionLive/multiterminal-marketplace
claude plugin install multiterminal@multiterminal-marketplace
```

Or use the interactive `/plugin` menu inside Claude Code and pick **multiterminal** from the `multiterminal-marketplace` source.

To update later:

```bash
claude plugin marketplace update multiterminal-marketplace
```

## Requirements

- **Claude Code** v2.1.139 or newer (the hooks use the `args: string[]` exec form).
- **Node.js** on your `PATH` — the hooks and the bundled MCP/channel server run under Node. Node 18+ recommended.
- **Platform:** the plugin bundles a prebuilt native `better-sqlite3` binary for **`win32-x64`** (see below). Other platforms work after a one-line rebuild.

## Native binary (`better-sqlite3`)

MultiTerminal's DB-backed features (terminal profiles, session lifecycle, activity tracking, the kanban board) use [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) **v11.10.0**, a native Node module. The compiled binary is **bundled** with the plugin at:

```
plugins/multiterminal/vendor/node_modules/better-sqlite3/build/Release/better_sqlite3.node
```

It is checked into git verbatim (`.gitattributes` marks `*.node` as `binary` so no line-ending conversion corrupts it). On a clean install the hooks resolve this bundled copy automatically — no `npm install` or build toolchain required on the typical target (Windows x64).

### Target ABI

The bundled binary is compiled for **`win32-x64`** against the Node ABI it was vendored with. A native module only loads under a matching Node **ABI version** (Node's `process.versions.modules`) and platform. If your runtime differs — a different Node major version, or a non-Windows / ARM machine — the bundled binary will not load and DB-backed features are disabled for the session (the rest of the plugin still works).

### Troubleshooting

If a session starts with a `⚠️ MultiTerminal: better-sqlite3 native module could not be loaded …` notice, pick any one of:

1. **Rebuild for your runtime** (fixes ABI/platform mismatch):
   ```bash
   cd "<plugin dir>/vendor/node_modules/better-sqlite3"
   npm rebuild better-sqlite3
   ```
2. **Use a global install** and point Node at it:
   ```bash
   npm install -g better-sqlite3
   # then ensure NODE_PATH includes your global node_modules
   ```
3. **Point at an explicit build** via environment variable — the resolver checks this first:
   ```bash
   set MT_BETTER_SQLITE3=C:\path\to\better-sqlite3   # Windows
   export MT_BETTER_SQLITE3=/path/to/better-sqlite3  # macOS/Linux
   ```

The resolution order (first hit wins) is: `MT_BETTER_SQLITE3` → bare `better-sqlite3` on `NODE_PATH` → the bundled `vendor/` copy → plugin-local `node_modules` → global npm. See `plugins/multiterminal/hooks/_sqlite.js`.

## What's in the box

- **Hooks** — session lifecycle, activity tracking, kanban pipeline triggers, safety guards.
- **Skills** — `session-start`, `kanban-task`, `project-management`, `program-management`, review/audit/diagnose pipelines, and more.
- **Agents** — verifier, code-reviewer, security-auditor, debugger, devil's-advocate, and supporting roles.
- **MCP / channel server** — the `multiterminal-channel` server wired via `plugin.json`.

## License / ownership

Maintained by **ClarionLive**.
