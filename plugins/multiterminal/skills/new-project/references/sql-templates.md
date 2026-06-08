# Project Registration — Use MCP Tools, NOT Direct SQL

## CRITICAL: Do NOT use direct SQLite writes

**Never** use `mcp__sqlite__write_query`, `mcp__sqlite__set_database`, `sqlite3` CLI, or raw SQL
to write project data to `multiterminal.db`.

The MultiTerminal MCP tools handle validation, cache invalidation, and event propagation that
raw database writes bypass. Direct writes cause stale caches and missing UI updates.

---

## SQL Safety (still applies to any string values)

Before passing any user-provided value to MCP tools, escape single quotes: `'` → `''`.

Applies to ALL user-supplied fields: PROJECT_NAME, PROJECT_DESCRIPTION, PROJECT_PATH, etc.

---

## Step 12.2: Project Record

Use `mcp__multiterminal__update_project` to set each field individually:

```
mcp__multiterminal__update_project(projectId="PROJECT_ID", field="build_command", value="dotnet build")
mcp__multiterminal__update_project(projectId="PROJECT_ID", field="deploy_path", value="H:\\path\\to\\deploy")
mcp__multiterminal__update_project(projectId="PROJECT_ID", field="source_path", value="H:\\path\\to\\source")
```

Supported fields: `build_command`, `deploy_command`, `launch_command`, `deploy_path`,
`build_output_path`, `source_path`, `project_type`, `icon`, `icon_color`, `description`,
`git_repo_url`, `git_default_branch`, `git_auto_commit`, `current_version`, `is_pinned`.

Run multiple update calls in parallel. Skip fields that are empty or not applicable.

---

## Step 12.3: Association Records

### Agents
```
mcp__multiterminal__add_project_agent(projectId="PROJECT_ID", agentName="Alice", role="coding")
```

### MCP Servers (add ALL gateway servers by default)
First call `mcp__mcp-gateway__gateway__list_servers()` to discover all registered servers,
then add each one to the project. Users expect all installed MCPs to be available — easier to
trim later than to add individually.
```
mcp__multiterminal__add_project_association(projectId="PROJECT_ID", associationType="mcp_server", name="mssql", isEnabled=true)
mcp__multiterminal__add_project_association(projectId="PROJECT_ID", associationType="mcp_server", name="sqlite", isEnabled=true)
# ... one call per server from gateway__list_servers
```

### Specialist Agents
```
mcp__multiterminal__add_project_association(projectId="PROJECT_ID", associationType="specialist_agent", name="verifier", isEnabled=true)
```

### Paths
```
mcp__multiterminal__add_project_association(projectId="PROJECT_ID", associationType="path", pathType="source", pathValue="H:\\path", description="Source code")
```

Run independent calls in parallel where possible.
