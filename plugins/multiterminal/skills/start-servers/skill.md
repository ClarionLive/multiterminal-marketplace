# start-servers

Start the ClaudeRemote server stack (ClaudeRemote + Caddy + optionally TTS). Use when beginning a ClaudeRemote session and the user needs phone access.

---

## Instructions

### 1. Check What's Already Running

Check ports in parallel:
- Port 5100 — ClaudeRemote HTTP
- Port 443 — Caddy HTTPS
- Port 5102 — TTS server (optional)

Use: `powershell -Command "netstat -ano | Select-String 'LISTENING' | Select-String '5100|443|5102'"`

### 2. Start Missing Services

Only start services that aren't already listening.

Resolve the ClaudeRemote project location (do NOT hardcode): `REMOTE_DIR` = `$env:MT_CLAUDE_REMOTE_PATH` if set, otherwise `H:\DevLaptop\Projects\ClaudeRemote`. **If `REMOTE_DIR` doesn't exist, skip the ClaudeRemote/TTS services with a note** (they're optional local services) and continue.

**ClaudeRemote** (port 5100):
```
start "" dotnet run --project <REMOTE_DIR>\ClaudeRemote.csproj
```

**Caddy** (port 443):
```
cd C:\Tools\Caddy && start "" caddy.exe run --config Caddyfile
```

**TTS server** (port 5102) — only start if user requests commentary features:
```
start "" node <REMOTE_DIR>\scripts\tts-server.js
```

Run each as a background command using `start ""` so they don't block.

### 3. Verify

Wait 3 seconds, then re-check that ports 5100 and 443 are listening. Report status:

```
ClaudeRemote: [running on :5100 | FAILED]
Caddy:        [running on :443  | FAILED]
TTS:          [running on :5102 | not started]
```

If any required service failed, show the error output.
