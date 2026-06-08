---
name: multiterminal-addproject
description: Create a new MultiTerminal project in the current directory by generating .claude/project.json
version: 1.2.0
---

# MultiTerminal Add Project Skill

Creates a `.claude/project.json` file in the current working directory and registers it in the central MultiTerminal registry.

## Step 1: Check if project already exists

```bash
powershell -Command "Test-Path '.claude/project.json'"
```

If result is `True`, inform user the project already exists and stop.

## Step 2: Create .claude directory

```bash
powershell -Command "New-Item -ItemType Directory -Path '.claude' -Force | Out-Null; 'OK'"
```

## Step 3: Detect project name

Look for project files to determine name. Check in order:
1. Read `*.csproj` or `*.sln` file if exists to get project name
2. Read `package.json` if exists to get name field
3. Use the current folder name from `pwd`

## Step 4: Generate values

Generate these values and store them for use in Steps 5 and 6:

```bash
powershell -Command "(New-Guid).ToString()"
```

```bash
powershell -Command "Get-Date -Format 'o'"
```

```bash
powershell -Command "(Get-Location).Path"
```

Store these as: GUID, DATETIME, PROJECT_PATH

## Step 5: Create project.json

Use the Write tool to create `.claude/project.json` with this content:

```json
{
  "id": "GUID",
  "name": "PROJECT_NAME",
  "description": "DESCRIPTION",
  "changeLog": "",
  "createdAt": "DATETIME",
  "lastOpenedAt": "DATETIME",
  "isPinned": false,
  "prompts": []
}
```

## Step 6: Get AppData path and update central registry

First, get the AppData path:
```bash
powershell -Command "[Environment]::GetFolderPath('ApplicationData')"
```

This will return the user's AppData\Roaming path.

The registry file is at: `{APPDATA_PATH}\MultiTerminal\projects.json`

Read the existing registry file using the Read tool with the full path (e.g., `{APPDATA_PATH}\MultiTerminal\projects.json`).

If the file doesn't exist or is empty, create this structure:
```json
{
  "version": 1,
  "projects": []
}
```

Add the new project entry to the `projects` array:
```json
{
  "id": "GUID",
  "name": "PROJECT_NAME",
  "path": "PROJECT_PATH",
  "lastOpenedAt": "DATETIME",
  "isPinned": false
}
```

Use the Write tool to save the updated registry to the full path (e.g., `{APPDATA_PATH}\MultiTerminal\projects.json`).

## Step 7: Confirm

Tell the user: "Created MultiTerminal project 'PROJECT_NAME' and registered it in the central registry."
