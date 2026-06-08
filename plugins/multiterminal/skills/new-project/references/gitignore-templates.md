# .gitignore Templates

Use the template matching the archetype's `gitignore_template` field.

---

## Template: clarion-com

Used by: Clarion COM, Clarion WebView2

```
# Build output
bin/
obj/
*.dll
*.pdb
*.suo
*.user
*.cache

# Visual Studio
.vs/
*.ncb
*.sdf

# COM registration artifacts
*.tlb
*.exp
*.lib

# NuGet
packages/
*.nupkg

# User-specific
*.userprefs
```

---

## Template: clarion-app

Used by: Clarion App

```
# Clarion temporary files
*.DCT.bak
*.APP.bak
*.obj
*.lst
*.dif
*.err
*.map

# Clarion compiler output
*.EXE
*.DLL
*.LIB

# Clarion IDE
*.clw~
*.app~

# Visual Studio Code
.vscode/

# OS artifacts
Thumbs.db
.DS_Store
```

---

## Template: dotnet

Used by: MultiTerminal Feature, Generic C#

```
# Build output
bin/
obj/
*.dll
*.pdb
*.exe

# Visual Studio
.vs/
*.suo
*.user
*.cache
*.rsuser

# NuGet
packages/
*.nupkg
*.snupkg

# Test results
TestResults/
coverage.xml

# User-specific
*.userprefs
launchSettings.json

# Node (for MCP server components)
node_modules/
npm-debug.log*

# OS artifacts
Thumbs.db
.DS_Store
```
