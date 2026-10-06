'use strict';
// End-to-end check of the RUNNING proxy (start it first:  node alias-proxy.js).  Run:  node diagnose.js
// Sends Claude Code-style requests to http://127.0.0.1:8082 and checks that native tool_use blocks come back.
const http = require('node:http');
const PORT = +(process.env.PORT || 8082);
const KEY = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || 'missing-key';
const MODEL = process.env.MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const sch = (name, description, required, properties) => ({ name, description, input_schema: { type: 'object', required, properties } });
const TOOLS = [sch('Read', 'Reads a file from the local filesystem.', ['file_path'], { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }),
  sch('Edit', 'Performs exact string replacements in files.', ['file_path', 'old_string', 'new_string'], { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }),
  sch('Write', 'Writes a file.', ['file_path', 'content'], { file_path: { type: 'string' }, content: { type: 'string' } }),
  sch('Bash', 'Executes a bash command.', ['command'], { command: { type: 'string' }, timeout: { type: 'number' } }),
  sch('Glob', 'Fast file pattern matching tool.', ['pattern'], { pattern: { type: 'string' }, path: { type: 'string' } }),
  sch('Grep', 'Search with ripgrep.', ['pattern'], { pattern: { type: 'string' }, path: { type: 'string' } })];
const FILLER = Array.from({ length: 500 }, (_, i) => `- Guideline ${i + 1}: keep answers concise, follow the project conventions, never invent file contents, and use tools to inspect the workspace.`).join('\n');
const SYSTEM = [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }, { type: 'text', text: 'Working directory: C:\\Users\\Admin\\Desktop\\Universe Builder (Windows).\n' + FILLER }];
const RIVER = 'C:\\Users\\Admin\\Desktop\\Universe Builder\\RIVER_REBUILD_UNREAL.md';
const mk = (messages, extra = {}) => ({ model: MODEL, max_tokens: 4000, stream: true, system: SYSTEM, tools: TOOLS, messages, ...extra });
const post = body => new Promise(res => { const d = JSON.stringify(body);
  const r = http.request({ hostname: '127.0.0.1', port: PORT, path: '/v1/messages?beta=true', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d), 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14' } },
    rs => { let t = ''; rs.setEncoding('utf8'); rs.on('data', x => t += x); rs.on('end', () => res({ status: rs.statusCode, raw: t })); });
  r.on('error', e => res({ status: 0, raw: e.message })); r.end(d); });
function summarize(raw) {
  const evs = raw.split('\n\n').filter(Boolean).map(b => { try { return JSON.parse(b.split('\n').find(l => l.startsWith('data:')).slice(5)); } catch { return null; } }).filter(Boolean);
  const bl = {}; let stop = null, ok = evs.length > 0 && evs.at(-1).type === 'message_stop';
  for (const e of evs) { if (e.type === 'content_block_start') bl[e.index] = { type: e.content_block.type, name: e.content_block.name, text: '', json: '' };
    if (e.type === 'content_block_delta' && bl[e.index]) { if (e.delta.type === 'text_delta') bl[e.index].text += e.delta.text; if (e.delta.type === 'input_json_delta') bl[e.index].json += e.delta.partial_json; }
    if (e.type === 'message_delta') stop = e.delta.stop_reason; }
  const list = Object.values(bl); list.forEach(b => { if (b.type === 'tool_use') { try { b.input = JSON.parse(b.json || '{}'); } catch { b.input = null; ok = false; } } });
  return { ok, stop, tools: list.filter(b => b.type === 'tool_use'), text: list.filter(b => b.type === 'text').map(b => b.text).join(' ').replace(/\s+/g, ' ').trim() };
}
let pass = 0, fail = 0;
async function scenario(name, body, check) {
  for (let t = 1; t <= 2; t++) {
    const r = await post(body);
    if (r.status === 0) { console.log(`\nFAIL  ${name}\n      cannot reach the proxy on port ${PORT}: ${r.raw}\n      Start it first:  node alias-proxy.js`); fail++; return; }
    if (r.status !== 200) { if (t === 2) { fail++; console.log(`\nFAIL  ${name}\n      HTTP ${r.status} ${r.raw.slice(0, 160)}`); } continue; }
    const s = summarize(r.raw); const res = s.ok ? check(s) : 'broken event stream';
    if (res === true) { pass++; return console.log(`\nPASS  ${name}\n      ${s.tools.length ? s.tools.map(x => x.name + ' ' + JSON.stringify(x.input).slice(0, 110)).join(' | ') : 'text "' + s.text.slice(0, 110) + '"'}`); }
    if (t === 2) { fail++; console.log(`\nFAIL  ${name}\n      ${res}. Model said: "${s.text.slice(0, 160)}"`); }
  }
}
(async () => {
  console.log(`Testing the running proxy on port ${PORT} (model ${MODEL})`);
  await scenario('1. Read RIVER_REBUILD_UNREAL.md -> native tool_use Read', mk([{ role: 'user', content: `Read the file ${RIVER}` }]), s => (s.tools[0] && s.tools[0].name === 'Read' && /RIVER_REBUILD_UNREAL/.test(s.tools[0].input.file_path || '') && s.stop === 'tool_use') || 'expected a Read tool_use');
  await scenario('2. Tool result round trip', mk([{ role: 'user', content: `Read the file ${RIVER}` }, { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_01ABCDEF', name: 'Read', input: { file_path: RIVER } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01ABCDEF', content: '# River rebuild\n1. Fold in the PCG harvests\n2. Do the Unreal-modelled rebuild\n' }, { type: 'text', text: 'Summarize the file in one sentence.' }] }]), s => /pcg|unreal|river|rebuild/i.test(s.text) || 'expected a summary of the file');
  const o = 'string p = "C:\\\\Maps\\\\a.json";', n = 'string p = @"C:\\Maps\\a.json";';
  await scenario('3. Exact Edit with quotes and backslashes', mk([{ role: 'user', content: `In C:\\Proj\\A.cs use the Edit tool to replace the exact line\n${o}\nwith\n${n}` }]), s => { const t = s.tools[0]; return (t && t.name === 'Edit' && (t.input.old_string || '').trim() === o && (t.input.new_string || '').trim() === n) || 'expected byte-exact Edit'; });
  await scenario('4. Glob search', mk([{ role: 'user', content: 'Find all C# files in the current folder with the Glob tool.' }]), s => (s.tools[0] && s.tools[0].name === 'Glob') || 'expected Glob');
  console.log(`\n--- ${pass} passed, ${fail} failed ---`);
  console.log(fail ? 'Send me the FAIL lines and the proxy window output (never your key).' : 'ALL PASS: the proxy turns the model\'s text into native tool calls. Run claude now.');
  process.exit(fail ? 1 : 0);
})();
