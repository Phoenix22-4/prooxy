'use strict';
// Self-test: runs the proxy against a scripted mock provider. `node test/selftest.js`
const http = require('node:http');
const assert = require('node:assert/strict');
process.env.TARGET_URL = 'http://127.0.0.1:18091';
process.env.PORT = '18092';
const proxy = require('../alias-proxy.js');

const TOOLS = [
  { name: 'Read', description: 'Reads a file from the local filesystem. More text here.', input_schema: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'Edit', description: 'Performs exact string replacements in files.', input_schema: { type: 'object', required: ['file_path', 'old_string', 'new_string'], properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } } } },
  { name: 'Write', description: 'Writes a file.', input_schema: { type: 'object', required: ['file_path', 'content'], properties: { file_path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'Grep', description: 'Search.', input_schema: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, output_mode: { enum: ['content', 'files_with_matches'] } } } },
  { name: 'mcp__blender__x', description: 'noise', input_schema: { type: 'object', properties: {} } },
];
const req0 = (extra = {}) => ({ model: 'm', max_tokens: 1000, stream: true, system: [{ type: 'text', text: 'sys' }], tools: TOOLS,
  messages: [{ role: 'user', content: 'go' }], ...extra });

// ---- mock provider
let script = [], seen = [], destroyed = 0;
const sse = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const msgStart = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], usage: { input_tokens: 10, output_tokens: 1 } } };
const textBlock = (i, parts) => [{ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
  ...parts.map(t => ({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: t } })), { type: 'content_block_stop', index: i }];
const thinkBlock = (i, t) => [{ type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: t } },
  { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: 'sig' } }, { type: 'content_block_stop', index: i }];
const end = (r = 'end_turn') => [{ type: 'message_delta', delta: { stop_reason: r }, usage: { output_tokens: 20 } }, { type: 'message_stop' }];
const reply = (events, opt = {}) => ({ events: [msgStart, ...events, ...end(opt.stop)], ...opt });

const mock = http.createServer((rq, rs) => {
  const c = []; rq.on('data', x => c.push(x)); rq.on('end', async () => {
    const body = c.length ? JSON.parse(Buffer.concat(c).toString()) : null; seen.push({ url: rq.url, body });
    const s = script.shift(); if (!s) { rs.writeHead(500); return rs.end('no script'); }
    if (s.status) { rs.writeHead(s.status, { 'content-type': 'application/json' }); return rs.end('{"error":"x"}'); }
    rs.writeHead(200, { 'content-type': 'text/event-stream' });
    rs.on('close', () => { if (!rs.writableEnded) destroyed++; });
    const bytes = Buffer.from(s.events.map(sse).join(''));
    const step = s.chunk || 37;                       // odd chunk size splits multibyte chars + events
    for (let i = 0; i < bytes.length; i += step) { rs.write(bytes.subarray(i, i + step)); await new Promise(r => setTimeout(r, 1)); }
    if (!s.hang) rs.end();
  });
});

const post = (path, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const r = http.request({ port: 18092, host: '127.0.0.1', path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, rs => {
    let t = ''; rs.setEncoding('utf8'); rs.on('data', x => t += x); rs.on('end', () => resolve({ status: rs.statusCode, text: t }));
  }); r.on('error', reject); r.end(data);
});
const events = text => text.split('\n\n').filter(Boolean).map(b => JSON.parse(b.split('\n').find(l => l.startsWith('data:')).slice(5)));
function checkStructure(evs) {
  const open = new Set(), used = new Set();
  for (const e of evs) {
    if (e.type === 'content_block_start') { assert(!used.has(e.index), 'duplicate block index ' + e.index); used.add(e.index); open.add(e.index); }
    if (e.type === 'content_block_delta') assert(open.has(e.index), 'delta on closed/unknown block ' + e.index);
    if (e.type === 'content_block_stop') { assert(open.has(e.index), 'stop without start'); open.delete(e.index); }
  }
  assert.equal(open.size, 0, 'unclosed blocks');
  assert.equal(evs[0].type, 'message_start'); assert.equal(evs[evs.length - 1].type, 'message_stop');
}
const tools = evs => evs.filter(e => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
const toolInput = (evs, start) => JSON.parse(evs.filter(e => e.type === 'content_block_delta' && e.index === start.index).map(e => e.delta.partial_json).join(''));
const stopReason = evs => evs.find(e => e.type === 'message_delta').delta.stop_reason;

const tests = {
  async 'thinking + text + raw XML Edit (quotes, backslashes, ∴ split across chunks)'() {
    const oldS = 'string p = "C:\\\\Maps\\\\a.json";\n    if (x < 3 && y > 2) { Debug.Log("hi"); }';
    const newS = 'string p = @"C:\\Maps\\a.json";\n    // ∴ résumé 日本語';
    script = [reply([...thinkBlock(0, '∴ thinking about 日本語'),
      ...textBlock(1, ['Let me edit. <tool', '_call name="Edit">\n<param name="file_path">C:\\Proj\\A.cs</par', `am>\n<param name="old_string">\n${oldS}\n</param>\n<param name="new_string">\n${newS}\n</param>\n<param name="replace_all">true</param>\n</tool_`, 'call>'])])];
    const r = await post('/v1/messages?beta=true', req0());
    const evs = events(r.text); checkStructure(evs);
    assert.equal(seen.at(-1).url, '/v1/messages?beta=true');
    const up = seen.at(-1).body;
    assert(!up.tools && !up.tool_choice, 'tools must be stripped'); assert.equal(up.stream, true);
    const sys = up.system.map(b => b.text).join('\n');
    assert(sys.includes('Edit(*file_path:string, *old_string:string, *new_string:string, replace_all:boolean)'), 'signature from schema');
    assert(sys.includes('Grep(*pattern:string, output_mode:"content"|"files_with_matches")'), 'enum signature');
    assert(!sys.includes('mcp__blender'), 'MCP noise dropped');
    const th = evs.filter(e => e.type === 'content_block_start' && e.content_block.type === 'thinking');
    assert.equal(th.length, 1); assert.equal(th[0].index, 0);
    const tl = tools(evs); assert.equal(tl.length, 1); assert.equal(tl[0].index, 2);
    assert.deepEqual(toolInput(evs, tl[0]), { file_path: 'C:\\Proj\\A.cs', old_string: oldS, new_string: newS, replace_all: true });
    assert.equal(stopReason(evs), 'tool_use');
    assert.equal(evs.filter(e => e.type === 'content_block_delta' && e.delta.type === 'text_delta').map(e => e.delta.text).join(''), 'Let me edit. ');
    assert(r.text.includes('∴ thinking about 日本語'), 'UTF-8 intact');
  },
  async 'JSON-mode call with raw newlines + trailing comma is repaired; name case fixed'() {
    script = [reply(textBlock(0, ['<tool_call>\n{"name":"write","parameters":{"file_path":"a.cs","content":"line1\nline2",}}\n</tool_call>']))];
    const evs = events((await post('/v1/messages', req0())).text); checkStructure(evs);
    const t = tools(evs)[0]; assert.equal(t.content_block.name, 'Write');
    assert.deepEqual(toolInput(evs, t), { file_path: 'a.cs', content: 'line1\nline2\n' });
  },
  async 'parallel calls, no empty text block, type coercion'() {
    script = [reply(textBlock(0, ['<tool_call name="Read"><param name="file_path">a</param><param name="limit">50</param></tool_call>\n<tool_call name="Read"><param name="file_path">b</param></tool_call>']))];
    const evs = events((await post('/v1/messages', req0())).text); checkStructure(evs);
    assert.equal(tools(evs).length, 2); assert.equal(toolInput(evs, tools(evs)[0]).limit, 50);
    assert.equal(evs.filter(e => e.type === 'content_block_start' && e.content_block.type === 'text').length, 0);
  },
  async 'malformed call triggers retry; client sees one clean call'() {
    script = [reply(textBlock(0, ['<tool_call name="Edit">this is garbage</tool_call>'])),
      reply(textBlock(0, ['<tool_call name="Edit"><param name="file_path">a</param><param name="old_string">x</param><param name="new_string">y</param></tool_call>']))];
    const before = seen.length;
    const evs = events((await post('/v1/messages', req0())).text); checkStructure(evs);
    assert.equal(seen.length - before, 2); const last = seen.at(-1).body.messages.at(-1);
    assert(last.role === 'user' && last.content.includes('[proxy]'));
    assert.equal(tools(evs).length, 1); assert.equal(stopReason(evs), 'tool_use');
    assert(!JSON.stringify(evs).includes('garbage'));
  },
  async 'provider-native fake tool (read_tabular) is rejected and retried'() {
    const fake = [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'read_tabular', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"p":"a"}' } }, { type: 'content_block_stop', index: 0 }];
    script = [reply(fake, { stop: 'tool_use' }), reply(textBlock(0, ['<tool_call name="Read"><param name="file_path">a</param></tool_call>']))];
    const evs = events((await post('/v1/messages', req0())).text); checkStructure(evs);
    assert.equal(tools(evs).length, 1); assert.equal(tools(evs)[0].content_block.name, 'Read');
  },
  async 'retries exhausted: raw call surfaced as text, end_turn'() {
    const b = reply(textBlock(0, ['<tool_call name="Nope"><param name="a">1</param></tool_call>']));
    script = [b, b, b];
    const evs = events((await post('/v1/messages', req0())).text); checkStructure(evs);
    assert.equal(tools(evs).length, 0); assert.equal(stopReason(evs), 'end_turn');
    assert(JSON.stringify(evs).includes('could not run a tool call'));
  },
  async 'text after a call (fabricated result) is cut and upstream aborted'() {
    script = [reply(textBlock(0, ['<tool_call name="Read"><param name="file_path">a</param></tool_call>', '\n\nThe file contains: ' + 'x'.repeat(2000)]), { hang: true })];
    const d0 = destroyed;
    const evs = events((await post('/v1/messages', req0())).text); checkStructure(evs);
    assert.equal(tools(evs).length, 1); assert(!JSON.stringify(evs).includes('The file contains'));
    await new Promise(r => setTimeout(r, 100)); assert(destroyed > d0, 'upstream aborted');
  },
  async 'upstream 503 is retried transparently'() {
    script = [{ status: 503 }, reply(textBlock(0, ['hello']))];
    const evs = events((await post('/v1/messages', req0())).text); checkStructure(evs);
    assert.equal(stopReason(evs), 'end_turn');
  },
  async 'non-retryable upstream error is passed through'() {
    script = [{ status: 401 }];
    assert.equal((await post('/v1/messages', req0())).status, 401);
  },
  async 'non-streaming client gets one JSON message'() {
    script = [reply([...thinkBlock(0, 'hm'), ...textBlock(1, ['ok <tool_call name="Read"><param name="file_path">z</param></tool_call>'])])];
    const r = await post('/v1/messages', req0({ stream: false })); const m = JSON.parse(r.text);
    assert.deepEqual(m.content.map(b => b.type), ['thinking', 'text', 'tool_use']);
    assert.deepEqual(m.content[2].input, { file_path: 'z' }); assert.equal(m.stop_reason, 'tool_use');
  },
  async 'count_tokens answered locally (no upstream call)'() {
    const n = seen.length; const r = await post('/v1/messages/count_tokens', req0());
    assert.equal(seen.length, n); assert(JSON.parse(r.text).input_tokens > 0);
  },
  async 'fake read_tabular history scrubbed; core-only tools; reminder on last user msg'() {
    script = [reply(textBlock(0, ['ok']))];
    await post('/v1/messages', req0({ tools: [...TOOLS, { name: 'CronCreate', description: 'x', input_schema: { type: 'object', properties: {} } }], messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_f1', name: 'read_tabular', input: { p: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_f1', is_error: true, content: 'failed' }, { type: 'text', text: 'continue' }] }] }));
    const up = seen.at(-1).body; const all = JSON.stringify(up.messages);
    assert(!all.includes('read_tabular"') && !all.includes('failed'), 'fake history removed');
    assert(!JSON.stringify(up.system).includes('CronCreate'), 'non-core tool dropped');
    assert(JSON.stringify(up.messages.at(-1)).includes('[proxy] Your real tools'));
  },
  async 'history flattening: results, images, thinking, empties, merging'() {
    const m = proxy.flattenMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 's' }, { type: 'text', text: 'reading' }, { type: 'tool_use', id: 'toolu_abc123', name: 'Read', input: { file_path: 'C:\\a.cs' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_abc123', content: [{ type: 'text', text: 'file body' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }] }, { type: 'text', text: 'thanks' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'only thinking', signature: 's' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_abc123', is_error: true, content: 'boom' }] },
    ]);
    assert.equal(m.length, 3); assert(!JSON.stringify(m).includes('secret'));
    assert(m[1].content.includes('<tool_call name="Read">\n<param name="file_path">C:\\a.cs</param>'));
    assert(m[2].content.some(b => b.type === 'image')); const txt = m[2].content.filter(b => b.type === 'text').map(b => b.text).join('');
    assert(txt.includes('<tool_result tool="Read" id="abc123">') && txt.includes('error="true"'));
  },
};

(async () => {
  await new Promise(r => mock.listen(18091, '127.0.0.1', r));
  await new Promise(r => proxy.server.listen(18092, '127.0.0.1', r));
  const log = console.log; let fail = 0;
  for (const [name, fn] of Object.entries(tests)) {
    console.log = () => {}; console.warn = () => {};
    try { await fn(); console.log = log; log('  ok   ' + name); }
    catch (e) { console.log = log; fail++; log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n       ')); }
  }
  log(fail ? `\n${fail} failed` : '\nall passed'); process.exit(fail ? 1 : 0);
})();
