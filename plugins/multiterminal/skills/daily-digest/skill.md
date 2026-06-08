# daily-digest

Fetch and summarize the daily AI/Claude ecosystem digest. Runs the fetch script to gather raw data from GitHub, Reddit, HN, and web sources, then summarizes into an actionable briefing.

Triggers on: '/daily-digest', 'daily digest', 'morning briefing', 'what happened today in AI'

---

## Instructions

### Step 1: Run the Fetch Script

Resolve the DailyDigest project location (do NOT hardcode): `DIGEST_DIR` = `$env:MT_DAILY_DIGEST_PATH` if set, otherwise `H:\DevLaptop\Projects\DailyDigest` (the historical default). **If `DIGEST_DIR` doesn't exist, tell the user the DailyDigest project isn't configured (set `MT_DAILY_DIGEST_PATH`) and stop — don't error.**

Run the fetch script to gather fresh raw data:

```bash
cd "<DIGEST_DIR>" && node src/fetch.js
```

This fetches from GitHub (Claude Code, MCP repos), Reddit (r/claudecode, r/ClaudeAI, r/vibecoding, r/LocalLLaMA), Hacker News (AI/Claude stories), and web sources (ShawnOS, Anthropic blog).

The output is saved to `<DIGEST_DIR>\digests\{today}\raw-data.json`.

### Step 2: Read and Analyze the Raw Data

Read the raw-data.json file. It contains:
- `github`: Array of repos with issues, PRs, and releases from the last 24h
- `reddit`: Array of subreddits with top posts
- `hn`: Array of top Hacker News stories about AI/Claude
- `web`: Array of web source content

### Step 3: Produce the Digest

Filter and summarize the raw data into a daily briefing. Focus on what's relevant to a team building multi-agent desktop apps with Claude Code, MCP servers, hooks, and skills.

**Output format:**

```markdown
# Daily Digest — {date}

## Headlines
- 3-5 most important items

## Claude Code & MCP
{Repo activity, new features, breaking changes, community tools}

## Community Highlights
{Top Reddit/HN discussions worth knowing about}

## New Tools & Repos
{Interesting new repos or tools}

## Competitor Watch
{Brief Codex/Gemini CLI notes — 2-3 sentences}

## Action Items
- Things to try, adopt, or watch
```

**Priority filtering:**
- HIGH: Claude Code changes, MCP updates, Anthropic API changes, security issues
- MEDIUM: Popular new tools, trending repos, high-engagement discussions
- LOW: General AI news, philosophical debates, memes (skip unless exceptional)

### Step 4: Save the Digest

1. Write the markdown to `<DIGEST_DIR>\digests\{today}\digest.md` (the `DIGEST_DIR` resolved in Step 1)

2. Store key insights in the knowledge base:
```
add_knowledge(topic="daily-digest-{date}", content="...", source="daily-digest")
```

3. Send a summary to ClaudeRemote (if remote mode is on):
```
send_push_notification(title="Daily Digest — {date}", body="Headlines: ...", notificationType="message", agentName="Alice")
```

### Step 5: Notify Agent of New Digest

After saving the digest, send a notification so the agent knows a fresh digest is available for action item triage:

```
send_message(fromTerminalId="your-id", to="Alice", message="New daily digest generated for {date}. Action items are ready for triage at next session start.")
```

Also send a push notification to ClaudeRemote so John knows:

```
send_push_notification(title="Daily Digest — {date}", body="Digest ready. {N} action items identified.", notificationType="message", agentName="Alice")
```

### Step 6: Present to User

Show the digest in the terminal. Keep it concise — the full version is in the markdown file.
