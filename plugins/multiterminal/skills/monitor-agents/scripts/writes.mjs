// writes.mjs — find outward-facing or destructive actions in a transcript.
//
// Usage: node writes.mjs <jsonl-path> [sinceLine]
//
// Scans the WHOLE input of every tool call. That is not a detail: the first version of this check
// (2026-09-17) matched only the first 160 characters of each command and reported "no pushes" for a
// run that had pushed two repos and posted a GitHub comment — every one of them began
// `cd "<repo>" && git log … && git push …`, so the push sat past the cut. A guard that reads a
// prefix answers a question nobody asked.
//
// Falsify it the same way before trusting it: point it at a transcript you KNOW contains a
// compound command ending in a push, and confirm it is listed.
import fs from 'node:fs';

const [file, since = '0'] = process.argv.slice(2);
if (!file) {
  console.error('usage: node writes.mjs <jsonl-path> [sinceLine]');
  process.exit(2);
}

const PATTERNS = [
  /\bgit\s+push\b/,
  /\bgh\s+(issue|pr)\s+(comment|close|edit|create|merge|reopen|review|lock|delete)\b/,
  /\bgh\s+(release|repo)\s+(create|delete|edit)\b/,
  /\bgh\s+api\b[^|;&]*-X\s*(POST|PATCH|PUT|DELETE)/i,
  /\bStop-Process\b|\btaskkill\b|\bkill\s+-/,
  /\bnpm\s+publish\b|\bdotnet\s+nuget\s+push\b/,
];

// Only tool calls that RUN something can perform these actions. Editing a file that merely mentions
// "git push" (a memory note, a skill doc) is not an action, and counting it trains the reader to
// ignore the scan — which is worse than not scanning.
const RUNNERS = new Set(['Bash', 'PowerShell', 'BashOutput']);

const lines = fs.readFileSync(file, 'utf8').split('\n');
let hits = 0;

for (let i = Number(since); i < lines.length; i++) {
  let rec;
  try { rec = JSON.parse(lines[i]); } catch { continue; }
  const content = rec.message && rec.message.content;
  if (!Array.isArray(content)) continue;

  for (const p of content) {
    if (p.type !== 'tool_use' || !RUNNERS.has(p.name)) continue;
    const s = JSON.stringify(p.input);
    for (const re of PATTERNS) {
      const m = s.match(re);
      if (!m) continue;
      hits++;
      const from = Math.max(0, m.index - 120);
      console.log(`[${i} ${(rec.timestamp || '').slice(11, 19)}] ${p.name} matched "${m[0]}": ${s.slice(from, m.index + 160)}`);
    }
  }
}

console.log(`-- writes scan: ${hits} hit(s) from line ${since}`);
