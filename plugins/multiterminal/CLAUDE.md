# This file is not loaded

Claude Code does not load a CLAUDE.md at a plugin's root, so nothing here ever reached an agent.
It is kept only so existing links do not break. Do not add instructions to it.

Where the MultiTerminal agent instructions live (task 9d3404d9):

- **Universal agent rules**: [`agent-rules.md`](agent-rules.md), printed into every MultiTerminal
  session (every project, normal and quiet start, and after compaction) by
  [`hooks/agent-rules-hook.js`](hooks/agent-rules-hook.js). It runs as its own SessionStart hook
  command because Claude Code caps each hook command's output at 10,000 characters; keep the file
  under 6,000 (`hooks/dispatch-test/unit-agent-rules.js` asserts it).
- **Workflows**: the skills under [`skills/`](skills/) (session-start, kanban-task,
  project-management, ...).
- **Tool usage**: the MCP tool descriptions in MultiTerminal's MCP server.
- **Rules for working on MultiTerminal's own source**: that repo's `.claude/CLAUDE.md` and
  `.claude/rules/`, which Claude Code loads natively.

The longer material this file used to hold (full auto-cd and worktree-prune walkthroughs, the
Remote Question Protocol, the MCP tool catalogue) was folded into `agent-rules.md` in compact form,
or dropped where the session-start skill (step 2.5) or the tool descriptions already cover it. It
is in git history before task 9d3404d9.
