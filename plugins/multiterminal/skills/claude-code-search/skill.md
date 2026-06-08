---
name: claude-code-search
description: Search Claude Code internals knowledge base — architecture, tools, commands, state management, patterns, and hidden features from the leaked source analysis.
version: 1.0.0
---

# claude-code-search

Search the Claude Code CLI knowledge base built from the reverse-engineering analysis of Claude Code's source code (1,884 TypeScript files, 512K+ lines).

## Instructions

### 1. Parse the Query

The user invokes this as `/claude-code-search <query>` where `<query>` is a natural language search term.

If no query is provided (just `/claude-code-search`), ask what they want to look up. Suggest topics:
- Tools (AgentTool, BashTool, FileEditTool, etc.)
- Commands (slash commands — commit, review, diff, etc.)
- Architecture (QueryEngine, state management, context builder)
- Special modes (Kairos, Bridge, Coordinator, Plan, Worktree)
- Services (API client, MCP, analytics, compaction)
- Plugins & Skills system
- Hooks & extensibility

### 2. Query the Database

Use the MCP Gateway SQLite tools to query the knowledge base:

**Step 1: Set the database**

Resolve the KB path (do NOT hardcode): `KB_DB` = `$env:MT_KB_DB` if set, else `<MT-project-root>/CLI Research/claude-code-kb.db` (project root = cwd / `$env:CLAUDE_PROJECT_DIR`). If `KB_DB` doesn't exist, tell the user the KB isn't configured (set `MT_KB_DB` or create the CLI Research KB) and stop — don't error.
```
mcp__mcp-gateway__sqlite__set_database(database_path="<KB_DB>")
```

**Step 2: Run FTS5 search**
```
mcp__mcp-gateway__sqlite__read_query(query="SELECT id, section, subsection, heading, content FROM cc_kb WHERE id IN (SELECT rowid FROM cc_kb_fts WHERE cc_kb_fts MATCH '\"<user_query>\"') ORDER BY section, chunk_index LIMIT 10")
```

**Important FTS5 notes:**
- Wrap the user's query in double-quotes inside the MATCH clause to do a phrase search
- If phrase search returns 0 results, retry WITHOUT double-quotes (individual term matching)
- Sanitize any double-quotes in the user's query by removing them before searching
- For broad topic searches, also try filtering by section: `WHERE section LIKE '%Tool%'`

### 3. Format Results

Present results as a clean markdown summary:

```
## Claude Code Internals: <topic>

### <heading> (from <section>)
<content>

### <heading> (from <section>)
<content>

---
*<N> results from Claude Code KB (87 chunks from source analysis)*
```

**Formatting rules:**
- Group results by section when they come from the same top-level section
- Preserve markdown tables and code blocks from the original content
- If content is a table, render it as-is (don't reformat)
- Add a brief 1-sentence summary at the top synthesizing what the results cover
- If no results found, suggest related terms or broader search queries

### 4. Offer Follow-ups

After presenting results, briefly suggest 1-2 related searches the user might want to try. For example:
- "For tool permissions, try: `/claude-code-search permission model`"
- "For how tools are registered, try: `/claude-code-search tool registry factory`"
