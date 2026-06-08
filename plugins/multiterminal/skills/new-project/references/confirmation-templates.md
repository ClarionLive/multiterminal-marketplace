# Confirmation Message Templates

## Create New
```
Project created successfully!

  Name:    PROJECT_NAME
  ID:      PROJECT_ID
  Path:    PROJECT_PATH
  Type:    ARCHETYPE
  Git:     Initialized (branch: main, initial commit made)

Files created:
  PROJECT_PATH\.claude\project.json
  PROJECT_PATH\.gitignore

Registered in:
  %APPDATA%\MultiTerminal\projects.json
  %APPDATA%\multiterminal\multiterminal.db (projects table + associations)

Team:         AGENTS_LIST
Optional MCPs: OPTIONAL_MCPS_LIST (global MCPs always included)
Specialists:  [auto-seeded from ~/.claude/agents/]

To open this project in MultiTerminal, reload the project panel or restart the app.
```

## Add Existing
```
Existing project registered successfully!

  Name:    PROJECT_NAME
  ID:      PROJECT_ID
  Path:    PROJECT_PATH
  Type:    ARCHETYPE
  Git:     [remote URL or "Local only" or "Initialized"]

Files created/updated:
  PROJECT_PATH\.claude\project.json [created/updated]
  PROJECT_PATH\.gitignore [created/skipped - already existed]

Registered in:
  %APPDATA%\MultiTerminal\projects.json
  %APPDATA%\multiterminal\multiterminal.db (projects table + associations)

Discovered:    [summary of auto-discovered fields]
Team:          AGENTS_LIST
Optional MCPs: OPTIONAL_MCPS_LIST (global MCPs always included)
Specialists:   [auto-seeded from ~/.claude/agents/]

To open this project in MultiTerminal, reload the project panel or restart the app.
```

If any step failed, report it clearly so the user knows what was skipped. A partial creation is better than an error.
