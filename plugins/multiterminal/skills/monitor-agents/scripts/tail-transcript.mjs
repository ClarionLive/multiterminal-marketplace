// tail-transcript.mjs — print a Claude Code transcript from a line number, readably.
//
// Usage: node tail-transcript.mjs <jsonl-path> [sinceLine]
//
// Prints one line per user text, assistant text, tool call and tool result, each prefixed with its
// LINE NUMBER and timestamp. The line number is the whole point: pass the last one back as
// <sinceLine> next check and you re-read nothing.
//
// This reads a file the other agent's CLI wrote. It sends nothing and touches nothing that agent
// can observe — which is the property the monitor role depends on.
//
// Caveat worth knowing (verification-discipline.md): the CLI STRIPS some framing the harness adds
// at request time, so a transcript is what was persisted, not the exact bytes the model saw. It is
// reliable for "what did this agent do"; it is not an oracle for "what did this agent receive".
import fs from 'node:fs';

const [file, since = '0'] = process.argv.slice(2);
if (!file) {
  console.error('usage: node tail-transcript.mjs <jsonl-path> [sinceLine]');
  process.exit(2);
}

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const lines = fs.readFileSync(file, 'utf8').split('\n');

for (let i = Number(since); i < lines.length; i++) {
  if (!lines[i]) continue;
  let rec;
  try { rec = JSON.parse(lines[i]); } catch { continue; }   // partial last line while the agent writes
  const msg = rec.message;
  if (!msg) continue;
  const ts = (rec.timestamp || '').slice(11, 19);
  const parts = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : (msg.content || []);

  for (const p of parts) {
    if (p.type === 'text' && p.text.trim()) {
      console.log(`[${i} ${ts}] ${msg.role.toUpperCase()}: ${clip(p.text, 1500)}`);
    } else if (p.type === 'tool_use') {
      console.log(`[${i} ${ts}] TOOL ${p.name}: ${clip(JSON.stringify(p.input), 300)}`);
    } else if (p.type === 'tool_result') {
      const t = typeof p.content === 'string' ? p.content : (p.content || []).map(c => c.text || '').join(' ');
      if (t.trim()) console.log(`[${i} ${ts}] RESULT: ${clip(t, 200)}`);
    }
  }
}

console.log(`-- ${lines.length} lines`);   // next check: pass this as <sinceLine>
