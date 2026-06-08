---
name: new-project
description: >
  Interactive wizard for onboarding projects into MultiTerminal. Trigger when the user wants to
  start, create, scaffold, or initialize a NEW project from an archetype (Clarion COM, WebView2,
  Clarion App, MT Feature, Generic C#), OR when they want to register, add, import, or onboard an
  EXISTING project folder so MultiTerminal can track it. Covers any "I have a folder I want
  MultiTerminal to know about" or "I want to start building something new" intent.
  Do NOT use for modifying existing registered projects or adding features to them.
version: 3.0.0
---

# /new-project — Project Wizard (Create New or Add Existing)

Two modes:
- **Create New** — Scaffold folders, pick archetype, init git, register in MultiTerminal
- **Add Existing** — Point at an existing folder, auto-discover project details, confirm, register

Reference files in `references/` contain lookup data (archetypes, templates, SQL). This file has the flow logic only.

---

## General Rules

These apply throughout the entire wizard. Do not repeat them in individual steps.

1. **Pre-filled values skip questions.** If a value was set by the New Project dialog (Step 0.5) or auto-discovery, skip any question that asks for it. Never re-ask for known information.

2. **GUID reuse.** If `PROJECT_ID` is already set (from the dialog API response or an existing `.claude/project.json`), reuse it. Only generate a new GUID in Step 7 if no ID exists yet. Generating a duplicate creates orphan records.

3. **SQL safety.** Before substituting any user-provided value into SQL, escape single quotes: `'` → `''`. See `references/sql-templates.md` for details.

4. **Archetype defaults.** All archetype field defaults are in `references/archetypes.md`. Reference that file instead of hardcoding values.

5. **Graceful degradation.** If any step fails (API down, DB locked, git missing), report clearly and continue with remaining steps. Partial creation is better than total failure.

---

## Step 0.5: Dialog Launch Detection

Runs first — before any user interaction.

1. Check `MULTITERMINAL_PROJECT_ID` env var: `echo "$MULTITERMINAL_PROJECT_ID"` (bash — NEVER use PowerShell for env vars).
   - If empty or not set → skip to Step 0.

2. Fetch project context: `mcp__multiterminal__get_project(projectId="{id}")`
   - If the call fails or `createdBy` is not `"new-project-dialog"` → skip to Step 0.

3. Extract from response: `PROJECT_NAME`, `PROJECT_PATH`, `PROJECT_ID`, `TEAM_LEAD`, `DEFAULT_TERMINAL` (if present; defaults to `claude-code`). Skip Step 0 → go to Step 0.6.

---

## Step 0.6: Folder State Detection

Only runs when launched from dialog (PROJECT_NAME and PROJECT_PATH pre-filled).

Scan the project folder in parallel:
```
Glob: *.sln, **/*.csproj, .git, package.json  (all at PROJECT_PATH)
```

**Case A — No indicator files found:** Empty/new folder. Go to Step 2 (Archetype Selection).
**Case B — Indicator files found:** Existing project. Go to Step E2 (Auto-Discovery).

---

## Step 0: Mode Selection

Use AskUserQuestion:
- **Create New** — "Scaffold a new project from scratch with folder structure, git init, and archetype defaults"
- **Add Existing** — "Register an existing project folder — I'll scan it and auto-discover the details"

Create New → Step 1 | Add Existing → Step E1

---

# CREATE NEW PATH (Steps 1-6)

## Step 1: Discovery

Ask for project name and short description (1-2 sentences). If user provides both in one message, extract both.

Store as: `PROJECT_NAME`, `PROJECT_DESCRIPTION`

## Step 2: Archetype Selection

Use AskUserQuestion with options:
1. **Clarion COM** — C# COM control for Clarion
2. **Clarion WebView2** — C# WebView2 control for Clarion
3. **Clarion App** — Native Clarion application
4. **MultiTerminal Feature** — New feature for the MultiTerminal codebase
5. **Generic C#** — Standard .NET class library, WinForms, or console app
6. **Other** — Follow up with technology/stack questions, default to Generic C#

Store as: `ARCHETYPE`

## Step 3: Archetype-Specific Questions

Ask targeted questions based on `ARCHETYPE`. Only ask what's not already known.

| Archetype | Questions |
|-----------|-----------|
| Clarion COM | Folder path, COM class name, target Clarion version (default: C11) |
| Clarion WebView2 | Folder path, control/panel name, use ClarionCOM WebView2 template? (default: yes) |
| Clarion App | Folder path, existing folder or new? |
| MT Feature | Feature area (panel/service/tool), subfolder within MultiTerminal |
| Generic C# | Folder path, .NET project type (class library/WinForms/console, default: class library) |

Store answers including `PROJECT_PATH`.

## Step 3.5: Default Terminal

Skip if `DEFAULT_TERMINAL` is already set (from Step 0.5 dialog launch, or from an existing `.claude/project.json` in the Add Existing path).

Ask: "Which terminal should this project default to?"
- **Claude Code** — The original MultiTerminal CLI. Rich hook pipeline, skills, subagents.
- **Codex** — OpenAI's Codex CLI. First-class team member via MCP; fewer hooks and no skills (Phase 1).

Map the answer to `DEFAULT_TERMINAL` using the canonical values `claude-code` or `codex`. Default to `claude-code` if the user hesitates — the project card's split button lets them override per-launch anyway.

## Step 4: Filesystem Scan

If the path already exists, scan it for context (existing files, .git, .claude/project.json).

- `EXISTING_FILES_FOUND`, `HAS_GIT`, `ALREADY_REGISTERED`
- If already registered: warn user, offer to open existing or re-register.
- If path doesn't exist: note it needs creation.

## Step 5: Build & Display Proposal

Load archetype defaults from `references/archetypes.md`. Assemble full configuration.

Display using the format in `references/proposal-format.md`.

## Step 6: Refinement

Use AskUserQuestion:
1. **Create it** — Proceed
2. **Change the path** — Update folder
3. **Change agents** — Add/remove team agents
4. **Change build config** — Update build/deploy/launch commands
5. **Start over** — Back to Step 0

If options 2-4: update, re-display proposal, ask again.
If "Create it" → Step 7.

---

# ADD EXISTING PATH (Steps E1-E6)

## Step E1: Path Input

Ask for the existing project folder path. Validate it exists. If not found: offer to re-enter or switch to Create New.

Store as: `PROJECT_PATH`

## Step E2: Auto-Discovery

Scan the folder to detect project details. Run checks in parallel where possible.

| Field | Detection Priority (first match wins) |
|-------|--------------------------------------|
| **Project type** | `.sln` or `.csproj` → dotnet | `package.json` → node | `.clw`/`.app` → clarion-app | `.py`/`requirements.txt` → python | fallback: unknown |
| **Build command** | Infer from project type + archetype defaults |
| **Project name** | `.claude/project.json` → `.sln` name → `.csproj` AssemblyName → `package.json` name → folder name |
| **Git info** | `.git` existence → `git remote get-url origin` → `git symbolic-ref --short HEAD` |
| **Deploy path** | Sibling `Deploy/` → `bin/Release` → `dist` → `output` → `publish` |
| **Existing config** | `.claude/project.json` → extract id, name, description, prompts, agents |
| **Documentation** | `README*`, `CLAUDE.md`, `.claude/CLAUDE.md` → read first 50 lines for context |

If `.claude/project.json` exists, check if already registered in SQLite by path.

## Step E3: Present Discovery Results

```
DISCOVERY RESULTS
Folder:       [PROJECT_PATH]
Project Name: [name] (source: [where found])
Project Type: [type] (source: [how detected])
Build:        [command or "Not detected"]
Deploy:       [path or "Not detected"]
Git:          [remote URL or "No remote" or "No git"]
Git Branch:   [branch or "N/A"]
Existing Config: [found/not found with details]
Key Files:    [.sln, .csproj, package.json, etc.]
```

## Step E4: Confirm and Fill Gaps

### E4.1: Confirm name and description
Pre-fill discovered name. Ask for description if not found.

### E4.2: Archetype matching
Suggest archetype based on detected type (see mapping table in `references/archetypes.md`). Offer to accept defaults, pick different type, or configure manually.

### E4.3: Fill remaining gaps
Only ask about fields that are truly empty and have no archetype default. Common gaps: deploy path, launch command, description.

### E4.4: Git settings
If git found: confirm remote URL, branch, auto-commit (default: yes).
If no git: offer to initialize or skip.

## Step E5: Build & Display Proposal

Same as Step 5 — load archetype defaults, assemble config, display using `references/proposal-format.md`.

## Step E6: Refinement

Same flow as Step 6. After approval → Step 7.

---

# SHARED PATH (Steps 7-13)

## Step 7: Pre-Creation Setup

1. **GUID**: Generate via `mcp__GUID-Generator__generate_guid()`. Fallback: PowerShell `(New-Guid).ToString()`.
2. **Datetime**: Get current time via PowerShell `Get-Date -Format 'o'`. Store as `NOW`.
3. **AppData**: Resolve via PowerShell `[Environment]::GetFolderPath('ApplicationData')` or use `%APPDATA%`.

## Step 8: Create Project Folder

- **Create New**: Create `PROJECT_PATH` and `PROJECT_PATH\.claude`.
- **Add Existing**: Only create `.claude` subfolder if missing.

## Step 9: Generate .gitignore

Skip if `.gitignore` already exists (check via Glob first).

Use the template matching the archetype's `gitignore_template` field from `references/gitignore-templates.md`.

## Step 10: Create project.json

Write `PROJECT_PATH\.claude\project.json`:

```json
{
  "id": "PROJECT_ID",
  "name": "PROJECT_NAME",
  "description": "PROJECT_DESCRIPTION",
  "changeLog": "",
  "currentVersion": "CURRENT_VERSION",
  "createdAt": "NOW",
  "lastOpenedAt": "NOW",
  "isPinned": false,
  "defaultTerminal": "DEFAULT_TERMINAL",
  "prompts": [],
  "team": {
    "agents": [AGENTS_JSON_ARRAY]
  }
}
```

`DEFAULT_TERMINAL` must be one of `claude-code` (default) or `codex`. Unknown values are normalized back to `claude-code` by the host on read.

For Add Existing with pre-existing file: preserve `createdAt`, `changeLog`, `currentVersion`, `prompts`, `defaultTerminal`.

## Step 11: Initialize Git

**IMPORTANT — Git safety rules:**
- **NEVER use `git add -A` or `git add .`** — the safety hook blocks these. Always stage specific files by name.
- Before committing, check if git user identity is configured: `git config user.name`. If empty, set it: `git config user.name "Project Owner"` and `git config user.email "owner@example.com"` (local to the repo). Ask the user for their preferred name/email if possible.

**Scenarios:**
- **Create New (no .git)**: `git init`, `checkout -b main`, stage specific files by name (e.g., `git add .gitignore .claude/project.json`), commit with Co-Authored-By tag.
- **Add Existing (has .git)**: Stage only `.claude/project.json` and `.gitignore` by name, commit as "Register PROJECT_NAME in MultiTerminal".
- **Add Existing (no git, user chose init)**: Same as Create New.
- **Add Existing (no git, user skipped)**: Skip entirely.

## Step 12: Register in MultiTerminal

### 12.1: projects.json registry

Read `%APPDATA%\MultiTerminal\projects.json` (create with `{"version":1,"projects":[]}` if missing). Add/update entry with `id`, `name`, `path`, `lastOpenedAt`, `isPinned`.

### 12.2: SQLite project record

**CRITICAL: Use MultiTerminal MCP tools, NOT direct SQLite writes.**

Never use `mcp__sqlite__write_query`, `mcp__sqlite__set_database`, or raw SQL to write project data.
The MultiTerminal MCP tools handle validation, caching, and event propagation that raw DB writes bypass.

Use `mcp__multiterminal__update_project` to set project fields:
```
mcp__multiterminal__update_project(
  projectId="PROJECT_ID",
  field="build_command",
  value="BUILD_COMMAND"
)
```

Call once per field that needs setting: `build_command`, `deploy_command`, `launch_command`,
`deploy_path`, `build_output_path`, `source_path`, `project_type`, `icon`, `icon_color`,
`git_repo_url`, `git_default_branch`, `git_auto_commit`, `current_version`, `description`,
`default_terminal`.

Skip fields that are empty or not applicable. Run multiple update calls in parallel where possible.

### 12.3: Association records

**Use MultiTerminal MCP tools for all associations:**

- **Agents**: `mcp__multiterminal__add_project_agent(projectId, agentName, role)` — one call per agent from archetype defaults.
- **MCP servers**: Call `mcp__mcp-gateway__gateway__list_servers()` to get ALL registered gateway servers, then add every server to the project via `mcp__multiterminal__add_project_association(projectId, associationType="mcp_server", ...)`. Users expect all installed MCPs to be available by default — it's easier to trim unused ones later than to wonder why they're missing.
- **Paths**: `mcp__multiterminal__add_project_association(projectId, associationType="path", ...)` for source path (always), deploy path (if set), build output path (if set).
- **Specialist agents**: Scan `%USERPROFILE%\.claude\agents\*.md`, add one per file found via `mcp__multiterminal__add_project_association(projectId, associationType="specialist_agent", ...)`.

Run independent association calls in parallel where possible.

## Step 13: Confirmation

Display the appropriate confirmation message from `references/confirmation-templates.md`.

If any step failed, report clearly what was skipped.
