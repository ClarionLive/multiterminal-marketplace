#!/usr/bin/env node
/**
 * context-threshold-hook.js
 *
 * Claude Code hook that nudges an agent to wrap up and self-clear when its
 * context window crosses a threshold. Designed for PostToolUse and
 * UserPromptSubmit hooks — emits the nudge as plain stdout (which Claude Code
 * surfaces as additional context), so it is ADVISORY and NON-blocking: the
 * agent notices at a natural boundary and decides when to clear. It never
 * forces a turn (no decision:"block") and never clears on the agent's behalf
 * (that's the clear_my_context MCP tool, called deliberately by the agent).
 *
 * Source of truth for context %: the per-terminal statusline file
 * %TEMP%/mt-statusline-{name}-{docId}.json written by scripts/statusline.js
 * (field `contextPct` = Claude Code context_window.used_percentage). Same files
 * StatusLineStatsReader.cs reads. Task 1d6e599d.
 *
 * Threshold: env MULTITERMINAL_CONTEXT_THRESHOLD (default 70). Escalating bands
 * 70/80/90 (or [threshold,80,90] filtered >= threshold). Debounced via a marker
 * file so the same band only nudges once; a higher band re-nudges; dropping
 * back below threshold (e.g. after a clear) resets so a later climb nudges again.
 *
 * Failure-tolerant: any missing file / parse error / no name → exit 0 silently.
 * Never blocks Claude.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Resolve the freshest statusline file for this terminal name (mirrors
// StatusLineStatsReader: exact docId file if known, else newest by the data's
// own timestamp, skipping siblings/zombies without a timestamp).
function findStatusFile(tmp, name, docId) {
  if (docId) {
    const exact = path.join(tmp, `mt-statusline-${name}-${docId}.json`);
    if (fs.existsSync(exact)) return exact;
  }
  let best = null;
  let bestTs = -1;
  let entries;
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return null;
  }
  const prefix = `mt-statusline-${name}-`;
  const now = Date.now();
  for (const f of entries) {
    if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
    const full = path.join(tmp, f);
    const data = readJsonSafe(full);
    if (!data || typeof data.timestamp !== 'number') continue;
    if (data.timestamp > now) continue; // future-dated → skewed/planted, skip
    if (data.timestamp > bestTs) {
      bestTs = data.timestamp;
      best = full;
    }
  }
  return best;
}

function main() {
  const name = process.env.MULTITERMINAL_NAME;
  if (!name) return; // not a MultiTerminal terminal

  const tmp = os.tmpdir();
  const docId = process.env.MULTITERMINAL_DOC_ID || null;
  const statusFile = findStatusFile(tmp, name, docId);
  if (!statusFile) return;

  const data = readJsonSafe(statusFile);
  if (!data) return;

  const pct = data.contextPct;
  if (typeof pct !== 'number' || !isFinite(pct)) return;

  // Ignore a very old reading so we never nudge off a zombie file (context can
  // only really be assessed from a recent render). 5 min is generous — an
  // actively-working terminal rewrites this every render.
  if (typeof data.timestamp === 'number') {
    const ageMs = Date.now() - data.timestamp;
    if (ageMs > 5 * 60 * 1000) return;
  }

  let threshold = parseInt(process.env.MULTITERMINAL_CONTEXT_THRESHOLD || '70', 10);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 100) threshold = 70;

  // Highest crossed band. Default bands 70/80/90; if threshold is raised above a
  // fixed band that band drops out.
  const bands = [...new Set([90, 80, threshold])].filter((b) => b >= threshold).sort((a, b) => b - a);
  let band = null;
  for (const b of bands) {
    if (pct >= b) { band = b; break; }
  }

  const markerPath = path.join(tmp, `mt-ctx-nudge-${name}.json`);

  if (band === null) {
    // Below threshold (e.g. fresh after a clear) — reset the marker so a future
    // climb re-nudges from the lowest band.
    try { if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath); } catch { /* ignore */ }
    return;
  }

  // Debounce: only nudge when entering a NEW (higher) band than last time.
  const marker = readJsonSafe(markerPath);
  if (marker && typeof marker.band === 'number' && marker.band >= band) return;

  try {
    fs.writeFileSync(markerPath, JSON.stringify({ band, pct, ts: Date.now() }), 'utf8');
  } catch {
    // If we can't persist the marker, still nudge once rather than spam: best effort.
  }

  const pctStr = Math.round(pct);
  let msg;
  if (band >= 90) {
    msg =
      `🔴 Context at ${pctStr}% — very full. Clear soon to stay ahead of auto-compact. ` +
      `Finish the immediate step, write continuation notes (update_task_continuation), ` +
      `then call clear_my_context (acknowledge:true) as your last action.`;
  } else if (band >= 80) {
    msg =
      `🟠 Context at ${pctStr}%. Wrap up at the next clean boundary: write continuation notes ` +
      `(update_task_continuation), then call clear_my_context to reset before continuing.`;
  } else {
    msg =
      `🟡 Context at ${pctStr}% (≥${threshold}% nudge threshold). Good time to aim for a stopping ` +
      `point soon — when you reach one, write continuation notes (update_task_continuation) and ` +
      `call clear_my_context. You choose the moment; this is just a heads-up.`;
  }

  // Plain stdout → Claude Code surfaces it as additional context. Advisory only.
  process.stdout.write(`## Context check\n${msg}\n`);
}

try {
  main();
} catch {
  // Never block Claude on a nudge.
}
process.exit(0);
