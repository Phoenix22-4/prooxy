'use strict';
// Runs probe.js against a mock relay that behaves like the one ccproxy's author documented:
// only lowercase read/write/edit/bash are honored natively; capitalized names are replaced by read_tabular; it can see images; thinking works.
const http = require('node:http'); const assert = require('node:assert'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { runProbe, redPng } = require('../probe.js');
const NATIVE = new Set(['read', 'write', 'edit', 'bash']);
const mock = http.createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'claude-opus-4-8' }] })); }
  let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => {
    const b = JSON.parse(raw), tools = (b.tools || []).map(t => t.name).filter(n => NATIVE.has(n)), json = c => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: b.model, stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 5 }, content: c })); };
    if (b.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); return res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'); }
    const last = b.messages[b.messages.length - 1], lc = Array.isArray(last.content) ? last.content : [];
    if (lc.some(x => x.type === 'image')) return json([{ type: 'text', text: 'Red.' }]);
    if (lc.some(x => x.type === 'tool_result')) return json([{ type: 'text', text: 'The secret word is PINEAPPLE-7.' }]);
    if (b.thinking) return json([{ type: 'thinking', thinking: '17*23=391', signature: 's' }, { type: 'text', text: '391' }]);
    if (typeof last.content === 'string' && /List the exact names/.test(last.content)) return json([{ type: 'text', text: tools.join(', ') || 'read_tabular, system_todo_write' }]);
    if (b.tool_choice) return tools.length ? json([{ type: 'tool_use', id: 'toolu_1', name: tools[0], input: { file_path: 'README.md' } }]) : json([{ type: 'tool_use', id: 'toolu_2', name: 'read_tabular', input: {} }]);
    json([{ type: 'text', text: 'ok' }]);
  });
});
(async () => {
  await new Promise(r => mock.listen(18199, '127.0.0.1', r)); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-')); const lines = [];
  const png = redPng(); assert.equal(png.slice(1, 4).toString(), 'PNG'); assert(png.length > 60);
  const c = await runProbe({ base: 'http://127.0.0.1:18199', key: 'SECRET', model: 'claude-opus-4-8', log: l => lines.push(l), dir });
  mock.close();
  assert.equal(c.native.works, true); assert.deepEqual(c.native.names.sort(), ['bash', 'edit', 'read', 'write']); assert.deepEqual(c.native.map, { Read: 'read', Write: 'write', Edit: 'edit', Bash: 'bash' });
  assert.equal(c.vision, true); assert.equal(c.thinking, true); assert.equal(c.stream, true); assert.deepEqual(c.models, ['claude-opus-4-8']);
  const saved = fs.readFileSync(path.join(dir, 'capabilities.json'), 'utf8'); assert(!saved.includes('SECRET') && !lines.join('\n').includes('SECRET'), 'the key is never printed or saved');
  assert(lines.join('\n').includes('"Read": ignored/replaced') && lines.join('\n').includes('"read": PASSED natively'));
  console.log(lines.join('\n')); console.log('\nprobe test: all passed'); process.exit(0);
})().catch(e => { console.log('probe test FAIL', e.stack || e); process.exit(1); });
