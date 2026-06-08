# Archetype Defaults Reference

## MCP Tier System

- **Multiterminal tier** (always): The `multiterminal` MCP server itself. Auto-included.
- **Global tier** (always): `windows-build-runner`, `everything-search`, `windowssnapit`, `dxdocs`. Auto-included.
- **Optional tier** (per-project): Only these appear as selectable choices in the wizard.

Skills and specialist agents are auto-managed (not part of wizard):
- Specialist agents are auto-seeded from `~/.claude/agents/` on creation.
- Skills are configured per-project in the Project Panel after creation.

---

## Archetype Defaults

### Clarion COM
```
project_type: "clarion-com"
build_command: "msbuild /t:Build /p:Configuration=Release"
build_output_path: "bin\\Release"
deploy_path: "[CLARIONCOM_HOME]\\Controls\\[ControlName]"
launch_command: ""
agents: ["Diana"]
optional_mcps: ["sqlite"]
gitignore_template: "clarion-com"
icon: "extension"
icon_color: "#4A90D9"
```

### Clarion WebView2
```
project_type: "clarion-webview2"
build_command: "msbuild /t:Build /p:Configuration=Release"
build_output_path: "bin\\Release"
deploy_path: "[CLARIONCOM_HOME]\\Controls\\[PanelName]"
launch_command: ""
agents: ["Diana"]
optional_mcps: ["sqlite"]
gitignore_template: "clarion-com"
icon: "web"
icon_color: "#7C4DFF"
```

### Clarion App
```
project_type: "clarion-app"
build_command: ""
build_output_path: ""
deploy_path: ""
launch_command: ""
agents: ["Diana", "Bob"]
optional_mcps: []
gitignore_template: "clarion-app"
icon: "apps"
icon_color: "#F5A623"
```

### MultiTerminal Feature
```
project_type: "multiterminal"
build_command: "dotnet build <MT_PATH>\\MultiTerminal.csproj"
build_output_path: "bin\\Release"
deploy_path: "<DEPLOY_PATH>"
launch_command: "<DEPLOY_PATH>\\MultiTerminal.exe"
source_path: "<MT_PATH>"
agents: ["Diana", "Charlie", "Bob"]
optional_mcps: ["sqlite", "mssql"]
gitignore_template: "dotnet"
icon: "hub"
icon_color: "#00BCD4"
```

### Generic C#
```
project_type: "dotnet"
build_command: "dotnet build"
build_output_path: "bin\\Release"
deploy_path: ""
launch_command: ""
agents: ["Diana"]
optional_mcps: ["sqlite"]
gitignore_template: "dotnet"
icon: "code"
icon_color: "#4CAF50"
```

---

## Quick Lookup Table

| Archetype | project_type | Agents | Optional MCPs | .gitignore |
|-----------|-------------|--------|---------------|------------|
| Clarion COM | clarion-com | Diana | sqlite | clarion-com |
| Clarion WebView2 | clarion-webview2 | Diana | sqlite | clarion-com |
| Clarion App | clarion-app | Diana, Bob | (none) | clarion-app |
| MultiTerminal Feature | multiterminal | Diana, Charlie, Bob | sqlite, mssql | dotnet |
| Generic C# | dotnet | Diana | sqlite | dotnet |

---

## Detected Type → Suggested Archetype (Add Existing mode)

| Detected Type | Suggested Archetype |
|---------------|-------------------|
| dotnet (with MultiTerminal path) | MultiTerminal Feature |
| dotnet (with COM indicators) | Clarion COM |
| dotnet (with WebView2 refs) | Clarion WebView2 |
| dotnet (general) | Generic C# |
| clarion-app | Clarion App |
| node | Generic C# (with node adjustments) |
| unknown | Generic C# |
