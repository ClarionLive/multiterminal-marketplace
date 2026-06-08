---
name: daily-intel
description: Daily intelligence pipeline — processes digest action items into suggestion tasks, checks for new Claude Code versions, updates the CLI knowledge base with changelogs, and sends the Owner a summary notification.
version: 1.0.0
---

# daily-intel

Daily intelligence pipeline that runs 4 phases:
1. **Digest Triage** — process action items into kanban suggestion tasks
2. **Version Watch** — check for new Claude Code CLI releases via npm
3. **KB Update** — if new version found, fetch changelog and append to the knowledge base
4. **Owner Notification** — send push notification with summary

Can be cron-triggered (daily) or manually invoked via `/daily-intel`.

---

## Instructions

### Phase 1: Digest Triage

**Step 1a:** Fetch today's digest action items.
```
get_daily_digest(section="action_items")
```

If no digest is available (tool returns empty/error), note "No digest available today" and skip to Phase 2.

**Step 1b:** Fetch existing suggestion tasks to avoid duplicates.
```
list_tasks(status="suggestion")
```

**Step 1c:** For each action item in the digest, triage against these criteria:
- Is it relevant to MultiTerminal, MCP tools, Claude Code hooks/skills, or our tech stack (C#/.NET, WebView2, Node.js)?
- Does it describe something actionable we could implement, adopt, investigate, or protect against?
- Is it a security issue, breaking change, or new capability that directly affects our codebase?

Skip items that:
- Already have a matching `[Digest]` suggestion on the board (check by keyword similarity in titles)
- Are purely informational ("be aware of X") without a concrete action
- Are about platforms/tools we don't use

**Step 1d:** For each actionable item, create a suggestion task:
```
create_task(
  title="[Digest] {concise action title}",
  description="{one-line summary}",
  status="suggestion",
  createdBy="YOUR_NAME"
)
```

Then add continuation notes with full context:
```
update_task_continuation(
  taskId="{new task id}",
  continuationNotes="Source: Daily Digest {date}\n\nWhat: {1-2 sentence description}\n\nWhy it matters: {impact on MultiTerminal}\n\nSuggested action: {what to do if approved}",
  updatedBy="YOUR_NAME"
)
```

**Rules:**
- Prefix title with `[Digest]` for board identification
- Security concerns get `priority="high"`
- Maximum 4 suggestions per digest — be selective
- Track how many suggestions were created for the summary

### Phase 2: Version Watch

**Step 2a:** Check the latest published version of Claude Code.

Run this Bash command:
```bash
npm view @anthropic-ai/claude-code version 2>/dev/null
```

This returns the latest version string (e.g., `2.1.90`).

**Step 2b:** Get the last known version from our KB.

First, **resolve the KB location** (do NOT hardcode a path):
- `KB_DB` = `$env:MT_KB_DB` if set; otherwise `<MT-project-root>/CLI Research/claude-code-kb.db` (the MT project root is your current working directory / `$env:CLAUDE_PROJECT_DIR`).
- `KB_DIR` = the directory containing `KB_DB` (i.e. `…/CLI Research`).
- **If `KB_DB` does not exist on disk, skip Version-Watch:** log "KB database not configured (set MT_KB_DB or create the CLI Research KB) — skipping version check" and jump to Phase 4. Do not error out.

Use MCP Gateway SQLite tools (substitute the resolved `KB_DB`):
```
mcp__mcp-gateway__sqlite__set_database(db_path="<KB_DB>")
mcp__mcp-gateway__sqlite__read_query(query="SELECT value FROM cc_metadata WHERE key = 'last_known_version'")
```

**Step 2c:** Compare versions.
- If same → log "No new version" and skip to Phase 4
- If different → new version detected, proceed to Phase 3
- If npm command fails → log "Version check failed" and skip to Phase 4

### Phase 3: KB Update (only if new version detected)

**Step 3a:** Fetch the changelog/release notes for the new version.

Try these sources in order:
1. **npm changelog**: `npm view @anthropic-ai/claude-code --json` — check the `description` or `readme` field
2. **GitHub releases**: Use WebFetch to fetch `https://api.github.com/repos/anthropics/claude-code/releases/latest` — the `body` field contains the changelog markdown
3. **Fallback**: If neither source has useful content, create a minimal entry noting the version bump

**Step 3b:** Run the update script to chunk and insert the changelog. Use the `KB_DIR` resolved in Step 2b (the `…/CLI Research` directory) — do not hardcode a path.

```bash
cd "<KB_DIR>" && node update-kb.js --version "{new_version}" --text "{changelog_text}"
```

For large changelogs, write to a temp file first:
```bash
echo '{changelog}' > /tmp/changelog.md
cd "<KB_DIR>" && node update-kb.js --version "{new_version}" --file /tmp/changelog.md
```

**Step 3c:** Verify the insert worked by checking the script output. It should report the number of chunks inserted.

Track the version number and chunk count for the summary.

### Phase 4: Owner Notification

Send a push notification summarizing what happened:
```
send_push_notification(
  title="Daily Intel Report",
  message="{summary}",
  priority="normal"
)
```

**Summary format:**
```
Daily Intel — {date}
- Digest: {N} suggestions created (or "nothing actionable" or "no digest today")
- Version: Claude Code v{X.Y.Z} detected, {N} changelog chunks added to KB (or "no new version")
```

If a new version was detected, set `priority="high"` on the notification.

### Error Handling

- If any phase fails, log the error and continue to the next phase. Don't let one failure block the entire pipeline.
- Always send the Phase 4 notification, even if other phases had errors — include the error info in the summary.
- The pipeline is idempotent: running it twice on the same day will skip already-created suggestions (title match) and already-ingested versions (dedup guard in update-kb.js).
