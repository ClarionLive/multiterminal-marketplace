# Multi-Connect Setup — Troubleshooting

Remediation for each failure mode in `SKILL.md`. All commands are Windows PowerShell. `$TS` is the
resolved full path to `tailscale.exe` (see SKILL.md Step 0). Diagnose with the listed commands;
report the exact error to the user rather than retrying blindly.

---

## Tailscale not installed / install failed

**Symptom:** Step 0 prints `TAILSCALE_NOT_FOUND` even after an install attempt.

**Checks:**
```powershell
Get-Command tailscale.exe -ErrorAction SilentlyContinue
Test-Path 'C:\Program Files\Tailscale\tailscale.exe'
```

**Causes & fixes:**
- PATH not refreshed in the current shell after install — this is why Step 0 also checks the absolute
  path `C:\Program Files\Tailscale\tailscale.exe`. Use that absolute path as `$TS` and continue.
- winget reported success but the MSI was deferred / needs a reboot — ask the user to confirm
  Tailscale appears in the system tray, or to reboot, then re-run.
- Install genuinely failed — fall back to the manual MSI (next section).

---

## winget (App Installer) absent → MSI fallback

**Symptom:** Step 2a prints `WINGET_MISSING`.

`winget` ships with the Microsoft "App Installer" package, which can be missing on fresh/LTSC/Server
Windows images. Do **not** guess a binary download URL.

**Fix — guide the user:**
1. Tell them to open the official download page: https://tailscale.com/download/windows
2. Download and run the Windows MSI installer.
3. Optionally, they can install App Installer from the Microsoft Store ("App Installer") to get
   `winget` for the future.
4. After they confirm install is complete, re-run SKILL.md **Step 0** to resolve `$TS`.

Never proceed past install without a resolved `$TS`.

---

## Node logged out (`BackendState = NeedsLogin`)

**Symptom:** Step 3/4 shows `BACKEND_STATE=NeedsLogin` (or `Stopped`), or `Self.DNSName` is empty.

**Checks:**
```powershell
& $TS status
```

**Fix:**
```powershell
& $TS up
```
This opens the browser login. The user must complete sign-in **and**, if the tailnet requires it, an
admin must approve the new machine in the Tailscale admin console
(https://login.tailscale.com/admin/machines). Re-poll `BackendState` until `Running`. Do not write
config while logged out.

---

## tailscaled service stopped / not running

**Symptom:** `tailscale status` errors with something like "failed to connect to local Tailscale
service" / "is Tailscale running?"; `BackendState` can't be read.

**Checks:**
```powershell
Get-Service Tailscale -ErrorAction SilentlyContinue | Select-Object Status, Name
```

**Fix (service control usually needs an elevated shell):**
```powershell
Start-Service Tailscale
```
If access is denied, tell the user to start the **Tailscale** service from an Administrator
PowerShell (`Start-Service Tailscale`) or by launching the Tailscale tray app, then re-run from
Step 3. If the service is missing entirely, the install is incomplete — reinstall (see above).

---

## Operator-permission error on `tailscale serve`

**Symptom:** Step 5 fails with "access denied", "operator", "must be run as the operator", or a
non-zero exit when calling `serve`.

By default `tailscale serve` may only be run by the configured *operator* user or from an elevated
process. Two paths:

**A. Set the current user as operator (often itself needs elevation):**
```powershell
& $TS set --operator $env:USERNAME
```
Then retry the serve command:
```powershell
& $TS serve --bg --https=$SERVE_PORT "http://localhost:$GATEWAY_PORT"
```

**B. Run serve from an elevated shell.** Give the user the exact command to paste into an
**Administrator** PowerShell:
```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' serve --bg --https=443 http://localhost:5100
```
(Substitute the real `SERVE_PORT` / `GATEWAY_PORT` if not the defaults.)

Verify afterwards:
```powershell
& $TS serve status
```

---

## Gateway port already in use

**Symptom:** Step 7 verify fails, or the gateway isn't answering on `GATEWAY_PORT`; another process
may hold the port.

**Checks:**
```powershell
netstat -ano | Select-String "LISTENING" | Select-String ":$GATEWAY_PORT\b"
```
Map the PID to a process:
```powershell
Get-Process -Id <PID>
```

**Fixes:**
- If the listener is **MultiTerminal's own gateway**, that's expected and good — the problem is
  elsewhere (re-check `tailscale serve status` and the `.ts.net` URL).
- If a *different* process owns the port, the gateway can't bind. Either stop that process, or change
  MultiTerminal's gateway port in the Multi-Connect Settings tab, restart the gateway, and re-run
  this skill (the new port flows through Step 1's `gatewayPort`).
- Note: `tailscale serve` maps the **public** `SERVE_PORT` (443) to the **local** `GATEWAY_PORT`
  (5100); a serve target pointing at the wrong local port looks like "verify fails" too. Confirm with
  `& $TS serve status`.

---

## /health unreachable (MultiTerminal not running)

**Symptom:** Step 1a prints `HEALTH_FAIL`.

**Checks:**
```powershell
netstat -ano | Select-String "LISTENING" | Select-String ":5050\b"
```

**Fix:** Ask the user to start the MultiTerminal desktop app. The REST API (port 5050) only runs
while the app is open. Re-run the skill once `/health` answers. No config is written until the
pre-flight gate passes.

---

## Endpoint 404 — installed MultiTerminal build is too old

**Symptom:** Step 1b prints `CONFIG_FAIL code=404` (the app answers `/health` but not
`/api/multi-connect/config`), or `schemaVersion` is a value this skill doesn't recognize.

**Meaning:** The running MultiTerminal build predates the Multi-Connect REST surface (or is newer than
this skill).

**Fix:**
- 404 → the build is too old. Update MultiTerminal to a build that includes the Multi-Connect Settings
  tab, then re-run. No changes are written on a 404 — the skill stops at the gate by design.
- Unrecognized `schemaVersion` → the app is newer than this skill. Update the marketplace plugin /
  `multi-connect-setup` skill to a version that understands the app's schemaVersion.

This gate exists specifically so the skill never reports "setup complete" while the final POST would
silently 404 against an old build.
