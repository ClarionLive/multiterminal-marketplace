---
name: multi-connect-setup
description: Guided, mostly-automatic setup of phone connectivity for MultiTerminal via Tailscale. Detects/installs Tailscale, brings the node up (one manual browser login), publishes the loopback gateway over HTTPS with `tailscale serve`, writes the detected hostname back into MultiTerminal's Multi-Connect config, and prints the final phone URL. Use when the user wants to connect their phone to MultiTerminal, set up remote/Multi-Connect access, or configure Tailscale for MT.
version: 1.0.0
---

# Multi-Connect Setup

Self-service phone connectivity for MultiTerminal. This skill does **most** of the work — the
only manual step is the Tailscale browser login (Tailscale requires it; it cannot be automated).

This skill is **instructions for you (the agent) to execute** step by step using the Bash /
PowerShell tools and `Invoke-RestMethod`. It is NOT a self-running script. Run the PowerShell
blocks below, read their output, branch on the results, and tell the user what is happening.

Platform: **Windows only** (uses winget / `C:\Program Files\Tailscale`). On other platforms, STOP
and tell the user this skill currently supports Windows.

> **Shell state does NOT persist between your tool calls.** The placeholders below — `$TS`,
> `$GATEWAY_PORT`, `$SERVE_PORT`, `$HOSTNAME` — are values **you** capture from one step's output and
> substitute as literals into later commands. When a later block references e.g. `$TS`, either run it
> in the *same* PowerShell invocation that defined it, or replace it with the literal value you
> recorded (e.g. `& 'C:\Program Files\Tailscale\tailscale.exe' status`). Do not assume a variable set
> in an earlier tool call is still defined.

> ## REST CONTRACT (authoritative — MultiConnectController.cs)
> Endpoints are **loopback-only on :5050** (this skill runs locally, so fine). The GET and POST shapes
> differ — read this carefully.
>
> **GET `/api/multi-connect/config` → 200.** Non-secret fields are NESTED `{ value, source }`; secrets
> are `{ isSet, source }` (never the raw value). `schemaVersion` is the STRING `"1.0"`. There is a
> COMPUTED `phoneUrl` at the top level — prefer it over building the URL yourself.
> ```json
> {
>   "schemaVersion": "1.0",
>   "gatewayPort":        { "value": 5100, "source": "settings|appsettings|default" },
>   "tailscaleEnabled":   { "value": false, "source": "..." },
>   "tailscaleHostname":  { "value": null,  "source": "..." },
>   "tailscaleServePort": { "value": 443,  "source": "..." },
>   "phoneAuthUsername":  { "value": "...", "source": "..." },
>   "phoneAuthPassword":  { "isSet": false, "source": "..." },
>   "notificationSecret": { "isSet": false, "source": "..." },
>   "vapidSubject":       { "value": "...", "source": "..." },
>   "relayBaseUrl":       { "value": "...", "source": "..." },
>   "relayApiKey":        { "isSet": false, "source": "..." },
>   "phoneUrl": "https://<host>"   // or "https://<host>:<port>" or null (computed)
> }
> ```
> Read scalars via `.value` (e.g. `$cfg.gatewayPort.value`, `$cfg.tailscaleServePort.value`).
>
> **POST `/api/multi-connect/config`** — body is FLAT camelCase (NOT nested). Per-field semantics:
> omit/null = unchanged, `""` = clear, value = set. Partial body is accepted — send only what you set.
> `gatewayPort` and `tailscaleServePort` are STRINGS in the POST body (send `"443"`, not `443`);
> `tailscaleEnabled` is a real bool. POST echoes back the full GET view on success.
> ```json
> { "tailscaleHostname": "<machine>.<tailnet>.ts.net", "tailscaleServePort": "443",
>   "tailscaleEnabled": true }
> ```
> **Gate:** accept `schemaVersion == "1.0"` only. Any other value, or 404, → STOP (Step 1).
>
> The contract is authoritative, but still descend into the ACTUAL GET keys at runtime (use `.value` /
> `.isSet`) rather than re-deriving names — minor casing drift then can't silently break the skill.
> Surface any 400 `{"error":"..."}` / 403 `{"error":"..."}` body verbatim to the user.

---

## Step 0: Resolve the Tailscale CLI path

Find `tailscale.exe`. Store the resolved full path as **`$TS`** for every later step (do NOT assume
it is on PATH — the installer adds it to `C:\Program Files\Tailscale` and PATH may not refresh until
a new shell).

```powershell
$ts = (Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source
if (-not $ts -and (Test-Path 'C:\Program Files\Tailscale\tailscale.exe')) {
    $ts = 'C:\Program Files\Tailscale\tailscale.exe'
}
if ($ts) { "TAILSCALE_FOUND=$ts" } else { "TAILSCALE_NOT_FOUND" }
```

- If `TAILSCALE_NOT_FOUND` → go to **Step 2 (Install)**, then return here.
- Otherwise remember the path and continue to **Step 1**.

---

## Step 1: Pre-flight / version handshake (DO THIS FIRST — it is a gate)

Do **not** install, run `tailscale up`, or write any config until this gate passes. Its whole job is
to refuse to proceed against a MultiTerminal build that predates the Multi-Connect endpoint, so we
never report "setup complete" while the POST silently 404s.

**1a. Is MultiTerminal running?**
```powershell
try {
    $h = Invoke-RestMethod -Uri 'http://localhost:5050/health' -TimeoutSec 5
    "HEALTH_OK"
} catch {
    "HEALTH_FAIL: $($_.Exception.Message)"
}
```
If `HEALTH_FAIL` → STOP. Tell the user MultiTerminal does not appear to be running on
`localhost:5050`; ask them to start the MultiTerminal app and re-run. (See troubleshooting:
"/health unreachable".)

**1b. Does the Multi-Connect endpoint exist, and is its schemaVersion recognized?**
```powershell
try {
    $cfg = Invoke-RestMethod -Uri 'http://localhost:5050/api/multi-connect/config' -TimeoutSec 5
    "CONFIG_OK schemaVersion=$($cfg.schemaVersion)"
    $cfg | ConvertTo-Json -Depth 5
} catch {
    $code = $null
    try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    "CONFIG_FAIL code=$code msg=$($_.Exception.Message)"
}
```

Branch on the result:
- **404 / CONFIG_FAIL** → **STOP**. Tell the user clearly:
  > Your installed MultiTerminal build predates the Multi-Connect endpoint (`/api/multi-connect/config`
  > returned 404 / was unreachable). Update MultiTerminal to a build that includes the Multi-Connect
  > Settings tab, then re-run this setup. No changes were made.
- **schemaVersion NOT exactly `"1.0"`** → **STOP**. Tell the user this skill (v1.0.0) understands
  Multi-Connect schemaVersion `"1.0"` but the app reports `<value>`; the skill may be older than the
  app. Ask them to update the marketplace plugin / skill. Do not write config.
- **CONFIG_OK with `schemaVersion == "1.0"`** → record these values for later and continue. Remember
  the fields are NESTED — read `.value`, not the bare key:
  - `GATEWAY_PORT` = `$cfg.gatewayPort.value` (default **5100** if null/absent)
  - `SERVE_PORT`   = `$cfg.tailscaleServePort.value` (default **443** if null/absent)
  - `PHONE_URL`    = `$cfg.phoneUrl` (may be null until we POST the hostname; used in Step 8)

---

## Step 2: Install Tailscale (only if Step 0 found nothing)

**2a. Prefer winget (App Installer):**
```powershell
if (Get-Command winget -ErrorAction SilentlyContinue) { "WINGET_OK" } else { "WINGET_MISSING" }
```

If `WINGET_OK`:
```powershell
winget install --id Tailscale.Tailscale -e --accept-source-agreements --accept-package-agreements
```
Then re-run **Step 0** to resolve `$TS`. (PATH may not refresh in the current shell — that is exactly
why Step 0 also checks `C:\Program Files\Tailscale`.)

**2b. winget missing → MSI fallback.** Do NOT silently guess a download URL. Tell the user:
> The Windows App Installer (winget) is not available, so I can't auto-install Tailscale. Please
> install it from the official site: https://tailscale.com/download/windows — download and run the
> MSI, then tell me when it's done and I'll continue.

After they confirm, re-run **Step 0**. If still not found, see troubleshooting ("Tailscale not
installed"). Never proceed past here without a resolved `$TS`.

---

## Step 3: Bring the node up — `tailscale up` (the one manual step)

Check current backend state first; only run `up` if it is not already `Running`.

```powershell
& $TS status --json 2>$null | ConvertFrom-Json | ForEach-Object { "STATE=$($_.BackendState)" }
```

If `STATE=Running`, skip to **Step 4**. Otherwise:

```powershell
& $TS up
```

Tell the user plainly:
> Tailscale is opening a browser window for you to log in. Complete the sign-in (and approve the
> machine if your tailnet requires admin approval). This is the only manual step. Let me know once
> you see "Success" / the browser says you're connected.

Then poll for Running (do not loop forever — about 6 tries, ~5s apart; report progress):
```powershell
$state = $null
for ($i = 0; $i -lt 6; $i++) {
    try { $state = (& $TS status --json 2>$null | ConvertFrom-Json).BackendState } catch {}
    if ($state -eq 'Running') { break }
    Start-Sleep -Seconds 5
}
"BACKEND_STATE=$state"
```
- `Running` → continue.
- `NeedsLogin` / `Stopped` / empty after retries → the login didn't complete or the service is down.
  See troubleshooting ("node logged out", "tailscaled service stopped"). Re-prompt the user, don't
  proceed.

---

## Step 4: Detect this machine's `.ts.net` hostname

```powershell
$st = & $TS status --json 2>$null | ConvertFrom-Json
$dns = $st.Self.DNSName
"DNSNAME_RAW=$dns BACKEND=$($st.BackendState)"
```

`Self.DNSName` is typically returned with a **trailing dot** (e.g. `box.tailnet-abc.ts.net.`). Strip
it and validate:
```powershell
$hostname = ($dns -as [string]).TrimEnd('.')
if ($hostname -match '\.ts\.net$') { "HOSTNAME=$hostname" } else { "HOSTNAME_INVALID=$hostname" }
```
- `HOSTNAME=...` → record as `HOSTNAME` and continue.
- `HOSTNAME_INVALID` or empty → backend may not be fully up, or MagicDNS is off. Re-check
  `BackendState`; see troubleshooting. Do not POST a bad hostname.

---

## Step 5: Publish the gateway over HTTPS — `tailscale serve`

Use the `GATEWAY_PORT` (default 5100) and `SERVE_PORT` (default 443) recorded in Step 1.

```powershell
& $TS serve --bg --https=$SERVE_PORT "http://localhost:$GATEWAY_PORT"
$LASTEXITCODE
```

Then confirm the proxy is registered:
```powershell
& $TS serve status
```

Handle these cases:
- **Operator-permission error** (e.g. "access denied", "operator", "must be run as ..."): `tailscale
  serve` needs to run as the configured operator or elevated. Offer to set the current user as
  operator (this itself usually needs an elevated shell):
  ```powershell
  & $TS set --operator $env:USERNAME
  ```
  If that also fails for permissions, tell the user to run the `tailscale serve` command from an
  **Administrator** PowerShell (give them the exact command). See troubleshooting ("operator
  permission error").
- **Non-zero exit / node not logged in** → revisit Step 3.
- Success → continue to Step 6.

---

## Step 6: Write detected values back to MultiTerminal

POST the detected hostname + serve port so the app stores them (and marks Tailscale enabled). The body
is FLAT camelCase, send only the keys you set, and **`tailscaleServePort` must be a STRING** (`"443"`,
not `443`); `tailscaleEnabled` is a real bool. On success the POST echoes back the full GET view —
capture it to read the computed `phoneUrl` for Step 8.

```powershell
$body = @{
    tailscaleHostname  = $HOSTNAME
    tailscaleServePort = [string]$SERVE_PORT   # STRING per contract
    tailscaleEnabled   = $true
} | ConvertTo-Json
try {
    $resp = Invoke-RestMethod -Uri 'http://localhost:5050/api/multi-connect/config' `
        -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 5
    "POST_OK phoneUrl=$($resp.phoneUrl)"
} catch {
    $code = $null; $errBody = $null
    try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    try {
        $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
        $errBody = $sr.ReadToEnd()
    } catch {}
    "POST_FAIL code=$code body=$errBody msg=$($_.Exception.Message)"
}
```
- `POST_FAIL code=400` → endpoint rejected the payload; the response body is `{"error":"<message>"}` —
  surface that exact message to the user (e.g. port out of range). Do not loop blindly.
- `POST_FAIL code=403` → body `{"error":"Loopback only"}` / `{"error":"Origin not allowed"}`; the call
  isn't coming from loopback. Make sure the skill runs locally on the MT host.
- `POST_FAIL code=404` → contradicts Step 1; the app may have restarted into an older build. STOP.
- `POST_OK` → record `phoneUrl` from the echoed response and continue.

---

## Step 7: Verify end-to-end over Tailscale

Prove the phone path actually works by hitting `/health` **through the public `.ts.net` HTTPS URL**
(not loopback). This exercises `tailscale serve` → gateway. Use the computed `phoneUrl` from the POST
echo (Step 6) as the base — it already encodes the right port — falling back to building it from
`$HOSTNAME` only if `phoneUrl` is null.

```powershell
$base = if ($PHONE_URL) { $PHONE_URL.TrimEnd('/') } else { "https://$HOSTNAME" }
try {
    Invoke-RestMethod -Uri "$base/health" -TimeoutSec 15 | Out-Null
    "VERIFY_OK base=$base"
} catch {
    "VERIFY_FAIL base=$base: $($_.Exception.Message)"
}
```
- `VERIFY_OK` → continue to Step 8.
- `VERIFY_FAIL` → most often DNS propagation lag, a still-starting serve, or a firewall. Wait ~10s and
  retry once. If it still fails, see troubleshooting ("gateway port already in use", "operator
  permission error") and report the exact error — do NOT claim success.

---

## Step 8: Print the phone URL

On success, show the user the final URL **clearly** and tell them what to do. Use the computed
`phoneUrl` (`$PHONE_URL`) from the Step 6 POST echo as the single source of truth — it already omits
`:443` and includes any non-default port. Only construct the URL yourself if `phoneUrl` is null
(`https://<HOSTNAME>/`, adding `:<SERVE_PORT>` when the serve port is not 443).

```
✅ Multi-Connect is set up.

   Open this on your phone (same Tailscale account, Tailscale app installed & connected):

       <PHONE_URL>

   You'll get the MultiTerminal login (PWA). Sign in with the phone username/password
   configured in MultiTerminal's Multi-Connect settings tab.
```

Replace `<PHONE_URL>` with the value from the GET/POST response.

Remind the user: the phone must have the **Tailscale app installed and connected to the same
tailnet** — the `.ts.net` URL only resolves inside Tailscale.

---

## Failure / STOP summary

Always leave the user with a clear state. If you STOP at any gate, say (a) what failed, (b) that no
further changes were made past that point, and (c) the one next action. The detailed remediation for
each failure mode is in `references/troubleshooting.md`:

- Tailscale not installed / install failed
- winget (App Installer) absent → MSI fallback
- Node logged out (`BackendState = NeedsLogin`)
- `tailscaled` service stopped / not running
- Operator-permission error on `tailscale serve`
- Gateway port already in use
- `/health` unreachable (MT not running)
- Endpoint 404 — installed MultiTerminal build is too old
