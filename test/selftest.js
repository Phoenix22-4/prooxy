'use strict';
// Self-test against a scripted mock provider (non-streaming JSON, like the real one).  node test/selftest.js
const http = require('node:http'); const assert = require('node:assert/strict');
process.env.TARGET_URL = 'http://127.0.0.1:18191'; process.env.PORT = '18192';
process.env.CALL_FORMAT = 'xml';
const proxy = require('../alias-proxy.js');
proxy.opts.TRANSPORT = 'text';   // old tests exercise the text bridge only
const TOOLS = [
  { name: 'Read', description: 'Reads a file from the local filesystem. More.', input_schema: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'Edit', description: 'Performs exact string replacements.', input_schema: { type: 'object', required: ['file_path', 'old_string', 'new_string'], properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } } } },
  { name: 'Write', description: 'Writes a file.', input_schema: { type: 'object', required: ['file_path', 'content'], properties: { file_path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'Glob', description: 'Find files.', input_schema: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' } } } },
  { name: 'read_tabular', description: 'provider fake', input_schema: { type: 'object', properties: {} } },
  { name: 'mcp__blender__x', description: 'noise', input_schema: { type: 'object', properties: {} } }];
const req0 = (x = {}) => ({ model: 'm', max_tokens: 1000, stream: true, system: [{ type: 'text', text: 'sys' }], tools: TOOLS, messages: [{ role: 'user', content: 'go' }], ...x });
let script = [], seen = [], hung = [];
const msg = (content, o = {}) => ({ json: { id: 'msg_1', model: 'm', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 20 }, content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, ...o } });
const mock = http.createServer((rq, rs) => { const c = []; rq.on('data', x => c.push(x)); rq.on('end', () => {
  seen.push({ url: rq.url, headers: rq.headers, body: JSON.parse(Buffer.concat(c).toString() || '{}') }); const s = script.shift();
  if (!s) { rs.writeHead(500); return rs.end('no script'); }
  if (s.status) { rs.writeHead(s.status, { server: 'cloudflare' }); return rs.end(s.body || ''); }
  if (s.hang) { hung.push(rs); return; }
  if (s.sse) { rs.writeHead(200, { 'content-type': 'text/event-stream' }); return rs.end(s.sse); }
  rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(JSON.stringify(s.json)); }); });
const post = (path, body, hdr = {}) => new Promise((resolve, reject) => { const d = JSON.stringify(body);
  const r = http.request({ port: 18192, host: '127.0.0.1', path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d), ...hdr } }, rs => { let t = ''; rs.setEncoding('utf8'); rs.on('data', x => t += x); rs.on('end', () => resolve({ status: rs.statusCode, text: t })); });
  r.on('error', reject); r.end(d); });
const events = t => t.split('\n\n').filter(Boolean).map(b => JSON.parse(b.split('\n').find(l => l.startsWith('data:')).slice(5)));
function structure(evs) { const used = new Set(), open = new Set();
  for (const e of evs) { if (e.type === 'content_block_start') { assert(!used.has(e.index)); used.add(e.index); open.add(e.index); if (e.content_block.type === 'text') { /* text must have a delta */ } }
    if (e.type === 'content_block_delta') assert(open.has(e.index)); if (e.type === 'content_block_stop') { assert(open.has(e.index)); open.delete(e.index); } }
  assert.equal(open.size, 0); assert.equal(evs[0].type, 'message_start'); assert.equal(evs.at(-1).type, 'message_stop');
  for (const e of evs) if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') assert(e.delta.text.trim().length > 0, 'no empty text blocks'); }
const tu = evs => evs.filter(e => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
const inp = (evs, s) => JSON.parse(evs.filter(e => e.type === 'content_block_delta' && e.index === s.index).map(e => e.delta.partial_json).join(''));
const stop = evs => evs.find(e => e.type === 'message_delta').delta.stop_reason;
const RIVER = 'C:\\Users\\Admin\\Desktop\\Universe Builder\\RIVER_REBUILD_UNREAL.md';

const tests = {
  async 'COMPACT: /compact is detected -> no tools, text-only note, streamed, history shrunk to the budget, tool-call text removed from the summary'() {
    const ev = (n, d) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`;
    const sseOf = text => ev('message_start', { type: 'message_start', message: { id: 'm', model: 'm', usage: { input_tokens: 9 } } }) + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) + ev('content_block_stop', { type: 'content_block_stop', index: 0 }) + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) + ev('message_stop', { type: 'message_stop' });
    const big = 'x'.repeat(30000), hist = [];
    for (let i = 0; i < 14; i++) { hist.push({ role: 'user', content: i ? [{ type: 'tool_result', tool_use_id: 'toolu_' + (i - 1), content: big }] : 'start the river rebuild' }); hist.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + i, name: 'Write', input: { file_path: 'a' + i + '.cs', content: big } }] }); }
    hist.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_13', content: 'ok' }, { type: 'text', text: "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions." }] });
    seen.length = 0; script = [{ sse: sseOf('<analysis>a</analysis>\n<summary>S1 river rebuild, continental rise open</summary>\n<tool_call name="Read"><param name="file_path">z</param></tool_call>') }];
    const evs = events((await post('/v1/messages', req0({ messages: hist }))).text); structure(evs); const up = seen.at(-1).body;
    assert.equal(up.stream, true, 'compaction streams (long output, avoids the 100s Cloudflare limit)');
    const sys = JSON.stringify(up.system); assert(!sys.includes('proxy_tools') && sys.includes('plain text only'), 'no tool bridge, text-only note');
    assert(JSON.stringify(up).length < 260 * 1024, 'history shrunk: ' + JSON.stringify(up).length); assert.equal(tu(evs).length, 0, 'no tool is ever executed during /compact');
    const out = JSON.stringify(evs); assert(out.includes('S1 river rebuild') && !out.includes('tool_call') && stop(evs) === 'end_turn');
    seen.length = 0; script = [msg('plain reply')]; await post('/v1/messages', req0()); assert(JSON.stringify(seen[0].body.system).includes('proxy_tools'), 'a normal request still gets the tools');
  },
  async 'TRIM: staged trimming gets a long session under budget, keeps the newest messages whole, never leaves call-shaped placeholders'() {
    const big = 'x'.repeat(30000), last = 'LASTBIG' + 'y'.repeat(30000), hist = [];
    for (let i = 0; i < 14; i++) { hist.push({ role: 'user', content: i ? [{ type: 'tool_result', tool_use_id: 'toolu_' + (i - 1), content: i === 13 ? last : big }] : 'start' }); hist.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + i, name: 'Write', input: { file_path: 'a' + i + '.cs', content: big } }] }); }
    hist.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_13', content: 'ok' }] });
    seen.length = 0; script = [msg('fine')]; await post('/v1/messages', req0({ messages: hist }));
    const m = seen[0].body.messages, all = JSON.stringify(m);
    assert(all.length < 230 * 1024, 'under budget: ' + all.length); assert(all.includes('LASTBIG'), 'newest tool output intact'); assert(all.includes('omitted by the proxy to save tokens'));
    assert(!/\[earlier[^\]]*\]\s*<tool_call/.test(all)); assert.equal(proxy.isCompaction({ messages: hist }), false);
    assert.equal(proxy.isCompaction({ messages: [{ role: 'user', content: 'Please create a detailed summary of the conversation so far.' }] }), true);
  },
  async 'STREAMING is per request: a 524 re-sends ONCE as a stream, the next request is a normal call'() {
    const ev = (n, d) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`;
    const sse = ev('message_start', { type: 'message_start', message: { id: 'm', model: 'm', usage: { input_tokens: 9 } } }) + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'slow but fine' } }) + ev('content_block_stop', { type: 'content_block_stop', index: 0 }) + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) + ev('message_stop', { type: 'message_stop' });
    seen.length = 0; script = [{ status: 524, body: 'error code: 524' }, { sse }, msg('next').json && { json: msg('next').json }];
    await post('/v1/messages', req0()); await post('/v1/messages', req0());
    assert.deepEqual(seen.map(s => s.body.stream), [false, true, false]);
  },
  async 'XML call -> native tool_use; request is stream=false, tools stripped, bridge text first, headers kept'() {
    script = [msg(`Let me read it.\n<tool_call name="Read">\n<param name="file_path">${RIVER}</param>\n<param name="limit">50</param>\n</tool_call>`)];
    const r = await post('/v1/messages?beta=true', req0(), { 'anthropic-beta': 'x-beta', authorization: 'Bearer K' });
    const evs = events(r.text); structure(evs); const t = tu(evs); assert.equal(t.length, 1); assert.deepEqual(inp(evs, t[0]), { file_path: RIVER, limit: 50 }); assert.equal(stop(evs), 'tool_use');
    const up = seen.at(-1); assert.equal(up.url, '/v1/messages?beta=true'); assert.equal(up.body.stream, false); assert(!up.body.tools);
    assert(up.body.system[0].text.startsWith('<proxy_tools>')); assert(!up.body.system[0].text.includes('mcp__blender') && !up.body.system[0].text.includes('read_tabular(') );
    assert(up.body.system[0].text.includes('### Edit') && up.body.system[0].text.includes('- file_path (string, required)') && up.body.system[0].text.includes('- replace_all (boolean)'));
    assert.equal(up.headers['anthropic-beta'], 'x-beta'); assert.equal(up.headers.authorization, 'Bearer K');
    assert(JSON.stringify(up.body.messages.slice(0, 4)).includes('bridge check ok'), 'few-shot present');
  },
  async 'JSON call with UNESCAPED Windows path and raw newline is repaired'() {
    script = [msg(`<tool_call>\n{"name": "Write", "parameters": {"file_path": "C:\\Users\\Admin\\a.cs", "content": "line1\nline2"}}\n</tool_call>`)];
    const evs = events((await post('/v1/messages', req0())).text); structure(evs); const t = tu(evs)[0];
    assert.deepEqual(inp(evs, t), { file_path: 'C:\\Users\\Admin\\a.cs', content: 'line1\nline2\n' });
  },
  async 'exact Edit: quotes, backslashes, unicode survive'() {
    const o = 'string p = "C:\\\\Maps\\\\a.json";\n  // ∴ 日本語', n = 'string p = @"C:\\Maps\\a.json";';
    script = [msg(`<tool_call name="edit">\n<param name="file_path">C:\\P\\A.cs</param>\n<param name="old_string">\n${o}\n</param>\n<param name="new_string">\n${n}\n</param>\n</tool_call>`)];
    const evs = events((await post('/v1/messages', req0())).text); const t = tu(evs)[0]; assert.equal(t.content_block.name, 'Edit');
    assert.deepEqual(inp(evs, t), { file_path: 'C:\\P\\A.cs', old_string: o, new_string: n });
  },
  async 'parallel calls; fabricated text after the calls is dropped'() {
    script = [msg('<tool_call name="Read"><param name="file_path">a</param></tool_call>\n<tool_call name="Glob"><param name="pattern">*.cs</param></tool_call>\nThe files contain: made-up stuff')];
    const evs = events((await post('/v1/messages', req0())).text); structure(evs); assert.deepEqual(tu(evs).map(t => t.content_block.name), ['Read', 'Glob']);
    assert(!JSON.stringify(evs).includes('made-up'));
  },
  async 'model refuses (mentions read_tabular) -> one retry -> tool call'() {
    script = [msg('I only have read_tabular here, no Read tool.'), msg('<tool_call name="Read"><param name="file_path">z</param></tool_call>')];
    const n = seen.length; const evs = events((await post('/v1/messages', req0())).text); structure(evs);
    assert.equal(seen.length - n, 2); assert.equal(tu(evs).length, 1); const last = seen.at(-1).body.messages.at(-1); assert(last.role === 'user' && last.content.includes('<tool_call'));
  },
  async 'malformed call -> retry -> clean call; user sees only the good one'() {
    script = [msg('<tool_call name="Edit">garbage</tool_call>'), msg('<tool_call name="Edit"><param name="file_path">a</param><param name="old_string">x</param><param name="new_string">y</param></tool_call>')];
    const evs = events((await post('/v1/messages', req0())).text); structure(evs); assert.equal(tu(evs).length, 1); assert(!JSON.stringify(evs).includes('garbage'));
  },
  async 'retries exhausted -> visible warning with what the model said, end_turn'() {
    const bad = msg('<tool_call name="Nope"><param name="a">1</param></tool_call>'); script = [bad, bad, bad, bad];
    const evs = events((await post('/v1/messages', req0())).text); structure(evs); assert.equal(tu(evs).length, 0); assert.equal(stop(evs), 'end_turn'); assert(JSON.stringify(evs).includes('could not be run'));
  },
  async 'thinking block from provider is forwarded with signature; empty reply gets a placeholder'() {
    script = [msg([{ type: 'thinking', thinking: '∴ hmm', signature: 'sg' }, { type: 'text', text: '<tool_call name="Read"><param name="file_path">a</param></tool_call>' }])];
    let evs = events((await post('/v1/messages', req0())).text); structure(evs);
    assert(evs.some(e => e.delta && e.delta.type === 'signature_delta')); assert.equal(evs.find(e => e.type === 'content_block_start').content_block.type, 'thinking');
    script = [msg([])]; evs = events((await post('/v1/messages', req0())).text); structure(evs); assert(JSON.stringify(evs).includes('empty reply'));
  },
  async 'CALL_FORMAT=json: prompt, history and few-shot use the JSON wrapper (parser accepts both formats either way)'() {
    const out = require('node:child_process').execFileSync(process.execPath, ['-e', `
      const p = require('./alias-proxy.js');
      const r = p.transform({ model: 'm', system: [{ type: 'text', text: 's' }], tools: ${JSON.stringify(TOOLS)}, messages: [{ role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:\\\\a.cs' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] }] });
      console.log('@@' + JSON.stringify({ sys: r.payload.system[0].text, msgs: r.payload.messages }));`],
      { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, CALL_FORMAT: 'json', TARGET_URL: 'http://127.0.0.1:1', PORT: '18199' } }).toString();
    const j = JSON.parse(out.split('@@')[1]); assert(j.sys.includes('"parameters"') && j.sys.includes('Escape it as valid JSON'));
    const hist = JSON.stringify(j.msgs); assert(hist.includes('<tool_call>\\n{\\"name\\":\\"Read\\",\\"parameters\\":{\\"file_path\\":\\"C:\\\\\\\\a.cs\\"}}'), 'history in JSON form');
    assert(!j.sys.includes('<param name='), 'no xml example in json mode');
  },
  async 'TUNNEL: model ignores the text bridge -> proxy switches to system_todo_write, unpacks the real call, then stays on it'() {
    proxy.opts.TRANSPORT = 'auto'; proxy.state.tunnel = false;
    try {
      const todo = c => ({ type: 'tool_use', id: 'srv_1', name: 'system_todo_write', input: { todos: [{ content: c, status: 'pending' }] } });
      const call = JSON.stringify({ name: 'Read', parameters: { file_path: RIVER } });
      script = [msg("I don't have a Read tool here, only read_tabular."), msg([todo(call), todo(call), { type: 'text', text: 'Done.' }])];
      const n = seen.length; const evs = events((await post('/v1/messages', req0())).text); structure(evs);
      assert.equal(seen.length - n, 2); assert(seen[n + 1].body.system[0].text.includes('system_todo_write') && !seen[n + 1].body.system[0].text.includes('<param name='), 'second request uses the tunnel prompt');
      const t = tu(evs); assert.equal(t.length, 1, 'duplicate todo items run once'); assert.deepEqual(inp(evs, t[0]), { file_path: RIVER }); assert(!JSON.stringify(evs).includes('Done.')); assert.equal(stop(evs), 'tool_use');
      assert(proxy.state.tunnel); script = [msg([todo(JSON.stringify({ name: 'Glob', parameters: { pattern: '*.cs' } }))])];
      const e2 = events((await post('/v1/messages', req0())).text); assert.equal(tu(e2)[0].content_block.name, 'Glob'); assert(seen.at(-1).body.system[0].text.includes('system_todo_write'), 'sticky tunnel on the next request');
    } finally { proxy.opts.TRANSPORT = 'text'; proxy.state.tunnel = false; }
  },
  async 'TUNNEL: an ordinary todo item is not run as a tool; a normal text answer does NOT trigger the tunnel'() {
    proxy.opts.TRANSPORT = 'auto'; proxy.state.tunnel = false;
    try {
      script = [msg([{ type: 'tool_use', id: 's', name: 'system_todo_write', input: { todos: [{ content: 'Write the unit tests', status: 'pending' }] } }, { type: 'text', text: 'Added.' }]), msg('x')];
      const n = seen.length; let evs = events((await post('/v1/messages', req0())).text); assert.equal(tu(evs).length, 0);
      script = [msg('The river rebuild folds in the PCG harvests first.')]; const m = seen.length; evs = events((await post('/v1/messages', req0())).text); structure(evs);
      assert.equal(seen.length - m, 1, 'plain answer: one request only'); assert(JSON.stringify(evs).includes('PCG harvests'));
    } finally { proxy.opts.TRANSPORT = 'text'; proxy.state.tunnel = false; }
  },
  async 'default call format is raw tags (JSON only via CALL_FORMAT=json)'() {
    const env = { ...process.env, TARGET_URL: 'http://127.0.0.1:1', PORT: '18198' }; delete env.CALL_FORMAT;
    const out = require('node:child_process').execFileSync(process.execPath, ['-e', `const p=require('./alias-proxy.js');const r=p.transform({model:'m',system:[{type:'text',text:'s'}],tools:${JSON.stringify(TOOLS)},messages:[{role:'user',content:'go'}]});console.log('@@'+JSON.stringify(r.payload.system[0].text));`], { cwd: require('node:path').join(__dirname, '..'), env }).toString();
    const sys = JSON.parse(out.split('@@')[1]); assert(sys.includes('<param name=') && !sys.includes('{"name": "Edit", "parameters"'));
  },
  async 'history: tool_use/tool_result become text; fake tool history scrubbed; images kept; empties dropped'() {
    const m = proxy.flattenMessages([{ role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'reading' }, { type: 'tool_use', id: 'toolu_abc123', name: 'Read', input: { file_path: 'C:\\a.cs' } }, { type: 'tool_use', id: 'toolu_f', name: 'read_tabular', input: { p: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_abc123', content: [{ type: 'text', text: 'body' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }] }, { type: 'tool_result', tool_use_id: 'toolu_f', content: 'fake fail' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'only' }] }]);
    assert.equal(m.length, 3); const s = JSON.stringify(m); assert(!s.includes('secret') && !s.includes('fake fail') && !s.includes('read_tabular'));
    assert(m[1].content.includes('<tool_call name="Read">\n<param name="file_path">C:\\a.cs</param>')); assert(m[2].content.some(b => b.type === 'image'));
  },
  async 'non-streaming client gets one JSON message; count_tokens is an estimate, not 100'() {
    script = [msg('ok <tool_call name="Read"><param name="file_path">z</param></tool_call>')];
    const m = JSON.parse((await post('/v1/messages', req0({ stream: false }))).text); assert.deepEqual(m.content.map(b => b.type), ['text', 'tool_use']); assert.equal(m.stop_reason, 'tool_use');
    const n = seen.length; const c = JSON.parse((await post('/v1/messages/count_tokens', req0({ messages: [{ role: 'user', content: 'x'.repeat(36000) }] }))).text); assert.equal(seen.length, n); assert(c.input_tokens > 5000);
  },
  async 'provider 503 retried; provider 403 passed through with status'() {
    script = [{ status: 503, body: 'No available channel' }, msg('hello')]; const evs = events((await post('/v1/messages', req0())).text); structure(evs); assert.equal(stop(evs), 'end_turn');
    script = [{ status: 403 }, { status: 403 }]; assert.equal((await post('/v1/messages', req0())).status, 403); assert.equal(script.length, 0, 'one delayed resend, then reported');
  },
  async 'empty Cloudflare 403 once -> delayed resend succeeds'() {
    script = [{ status: 403 }, msg('<tool_call name="Read"><param name="file_path">a</param></tool_call>')];
    const evs = events((await post('/v1/messages', req0())).text); structure(evs); assert.equal(tu(evs).length, 1);
  },
  async 'YOUR FAILURE: invalid JSON Edit with C# code -> NO echo of failed text; switches to raw-tag format, sticky'() {
    proxy.state.fmt = 'json'; seen.length = 0;
    const csharp = 'public static bool Foo() { /// summary \\ "quoted" Process.Start("x"); }';
    const bad = `Now I'll insert the helper. <tool_call>\n{"name":"Edit","parameters":{"file_path":"A.cs","old_string":"x","new_string":"${csharp}"}}\n</tool_call>`;   // unescaped quotes/backslash = invalid JSON
    const good = `<tool_call name="Edit">\n<param name="file_path">A.cs</param>\n<param name="old_string">x</param>\n<param name="new_string">\n${csharp}\n</param>\n</tool_call>`;
    script = [msg(bad), msg(good)];
    const evs = events((await post('/v1/messages', req0())).text); structure(evs); const t = tu(evs); assert.equal(t.length, 1, 'good call delivered');
    assert.equal(inp(evs, t[0]).new_string.trim(), csharp, 'code arrives byte-exact');
    assert.equal(seen.length, 2); const second = JSON.stringify(seen[1].body);
    assert(!second.includes('Process.Start'), 'failed text must NOT be sent back to the provider');
    assert(!second.includes('Now I\'ll insert'), 'no assistant echo');
    assert(seen[1].body.system[0].text.includes('<tool_call name='), 'second request uses the raw <param> format');
    assert.equal(proxy.state.fmt, 'xml', 'sticky for later requests');
    script = [msg('<tool_call name="Read"><param name="file_path">a</param></tool_call>')]; seen.length = 0; await post('/v1/messages', req0());
    assert(seen[0].body.system[0].text.includes('<tool_call name='), 'later requests start on the raw format'); proxy.state.fmt = null;
  },
  async 'LONG LOOP: 40 mixed-tool turns, every turn tool_use, ids unique, history intact, then a clean end_turn'() {
    const mk = (n, req, props) => ({ name: n, description: n + ' tool.', input_schema: { type: 'object', required: req, properties: props } });
    const S = { type: 'string' };
    const T = [mk('Read', ['file_path'], { file_path: S, offset: { type: 'number' } }), mk('Edit', ['file_path', 'old_string', 'new_string'], { file_path: S, old_string: S, new_string: S }),
      mk('Write', ['file_path', 'content'], { file_path: S, content: S }), mk('Bash', ['command'], { command: S, timeout: { type: 'number' } }), mk('Grep', ['pattern'], { pattern: S, path: S }),
      mk('Glob', ['pattern'], { pattern: S }), mk('WebFetch', ['url'], { url: S }), mk('read_tabular', [], {})];
    const plan = [];
    for (let i = 0; i < 40; i++) { const k = i % 6;
      plan.push([['Read', { file_path: `C:\\proj\\f${i}.py`, offset: i }], ['Edit', { file_path: `f${i}.js`, old_string: `a "q" \\ ${i}`, new_string: `b 'q' \\\\ ${i}\n  x` }], ['Write', { file_path: `n${i}.json`, content: `{"k": "v\\n", "i": ${i}}` }],
        ['Bash', { command: `echo "hi" && dir C:\\x${i}`, timeout: 5000 }], ['Grep', { pattern: `foo|bar${i}`, path: '.' }], ['Glob', { pattern: `**/*.cs` }]][k]); }
    const wire = ([n, p]) => `<tool_call name="${n}">\n` + Object.entries(p).map(([k, v]) => `<param name="${k}">${String(v).includes('\n') ? '\n' + v + '\n' : v}</param>`).join('\n') + '\n</tool_call>';
    script = [...plan.map(c => msg([{ type: 'thinking', thinking: 'hmm ' + c[0], signature: 'sg' }, { type: 'text', text: 'Next step.\n' + wire(c) }])), msg('All 40 steps are done.')];
    seen.length = 0; const messages = [{ role: 'user', content: 'do all 40 tasks without stopping' }]; const ids = new Set(); let lastSize = 0;
    for (let i = 0; i < 40; i++) {
      const evs = events((await post('/v1/messages', { model: 'm', max_tokens: 1000, stream: true, system: [{ type: 'text', text: 'sys' }], tools: T, messages })).text); structure(evs);
      assert.equal(stop(evs), 'tool_use', 'turn ' + i + ' must be tool_use so Claude Code keeps looping'); const t = tu(evs); assert.equal(t.length, 1); assert.equal(t[0].content_block.name, plan[i][0]);
      assert.deepEqual(inp(evs, t[0]), Object.fromEntries(Object.entries(plan[i][1]).map(([k, v]) => [k, typeof v === 'number' ? v : v])), 'params byte-exact on turn ' + i);
      assert(!ids.has(t[0].content_block.id)); ids.add(t[0].content_block.id);
      const th = evs.find(e => e.type === 'content_block_start' && e.content_block.type === 'thinking'); assert(th, 'thinking forwarded on turn ' + i);
      messages.push({ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sg' }, { type: 'text', text: 'Next step.' }, { type: 'tool_use', id: t[0].content_block.id, name: plan[i][0], input: inp(evs, t[0]) }] });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: t[0].content_block.id, content: 'result ' + i }] });
      const up = JSON.stringify(seen.at(-1).body); assert(!up.includes('"thinking"') && !up.includes('"tools"'), 'no thinking blocks or tools array sent upstream'); assert(up.includes('result ' + Math.max(0, i - 1)) || i === 0, 'history carried');
      lastSize = up.length; }
    const evs = events((await post('/v1/messages', { model: 'm', max_tokens: 1000, stream: true, system: [{ type: 'text', text: 'sys' }], tools: T, messages })).text); structure(evs);
    assert.equal(stop(evs), 'end_turn'); assert.equal(tu(evs).length, 0); assert(JSON.stringify(evs).includes('All 40 steps')); assert.equal(script.length, 0);
  },
  async 'DROP_TOOLS=AskUserQuestion,EnterPlanMode removes them from the prompt (checked in a child process); default keeps them'() {
    const { execFileSync } = require('node:child_process');
    const run = env => JSON.parse(execFileSync(process.execPath, ['-e', `process.env.PORT='18199';const p=require('./alias-proxy.js');const mk=n=>({name:n,description:'d',input_schema:{type:'object',properties:{}}});console.log=()=>{};const r=p.transform({model:'m',system:'s',messages:[{role:'user',content:'x'}],tools:['Read','Edit','AskUserQuestion','EnterPlanMode','ExitPlanMode'].map(mk)},'text');process.stdout.write(JSON.stringify(r.tools.map(t=>t.name)));process.exit(0)`], { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, ...env }, encoding: 'utf8' }));
    assert.deepEqual(run({ DROP_TOOLS: '' }), ['Read', 'Edit', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode']);
    assert.deepEqual(run({ DROP_TOOLS: 'AskUserQuestion,EnterPlanMode' }), ['Read', 'Edit', 'ExitPlanMode']);
  },
  async 'SIDE-REQUEST (auto-mode safety check): forced custom tool is emulated and returned as a native tool_use'() {
    const verdict = { name: 'report_verdict', description: 'Report whether the action is safe.', input_schema: { type: 'object', required: ['block', 'reason'], properties: { block: { type: 'boolean' }, reason: { type: 'string' } } } };
    script = [msg('<tool_call name="report_verdict">\n<param name="block">false</param>\n<param name="reason">read-only status query</param>\n</tool_call>')]; seen.length = 0;
    const evs = events((await post('/v1/messages', { model: 'm', max_tokens: 200, stream: true, system: 'You judge shell commands.', tools: [verdict], tool_choice: { type: 'tool', name: 'report_verdict' }, messages: [{ role: 'user', content: 'Command: Get-Process Unity' }] })).text); structure(evs);
    const up = JSON.stringify(seen.at(-1).body); assert(up.includes('report_verdict('), 'forced tool described to the model'); assert(!seen.at(-1).body.tools && !seen.at(-1).body.tool_choice);
    const t = tu(evs); assert.equal(t.length, 1); assert.equal(t[0].content_block.name, 'report_verdict'); assert.deepEqual(inp(evs, t[0]), { block: false, reason: 'read-only status query' }); assert.equal(stop(evs), 'tool_use');
  },
  async 'SIDE-REQUEST: a small custom tool set with no forced choice is also emulated; the big agent request still gets core tools only'() {
    const r = proxy.transform({ model: 'm', system: 's', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'my_side_tool', description: 'd', input_schema: { type: 'object', properties: {} } }] }, 'text'); assert.deepEqual(r.tools.map(t => t.name), ['my_side_tool']);
    const r2 = proxy.transform(req0(), 'text'); assert.deepEqual(r2.tools.map(t => t.name), ['Read', 'Edit', 'Write', 'Glob']);
  },
  async 'SIDE-REQUEST capture: PROXY_CAPTURE=1 writes request + provider reply to disk, no headers/keys'() {
    const os = require('node:os'), fs = require('node:fs'), path = require('node:path'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
    process.env.PROXY_CAPTURE = '1'; process.env.CAPTURE_DIR = dir; script = [msg('<severity>1</severity>')];
    await post('/v1/messages', { model: 'm', max_tokens: 64, stream: true, system: 'You are a monitor. Answer yes or no.', stop_sequences: ['</block>'], messages: [{ role: 'user', content: 'CLAUDE.md here. Command: tasklist' }] }, { authorization: 'Bearer SECRET-KEY' });
    delete process.env.PROXY_CAPTURE; const files = fs.readdirSync(dir); assert.equal(files.length, 1); const txt = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    const j = JSON.parse(txt); assert.deepEqual(j.request.stop_sequences, ['</block>']); assert(txt.includes('<severity>1</severity>') && txt.includes('tasklist')); assert(!txt.includes('SECRET-KEY'));
  },
  async 'YOUR LOG: model closes with </parameter> and </invoke> -> clean Edit, no stray tags written into the file'() {
    const NL = '#11 ✅ (§7 T6), #12 ✅ (§7 T7).';
    // exactly the shapes seen in the log: closers mixed up, call ended with </invoke> instead of </tool_call>
    script = [msg(`<tool_call name="Edit">\n<param name="file_path">${RIVER}</param>\n<param name="old_string">${NL}</parameter>\n</parameter>\n</param>\n<param name="new_string">${NL}\n#4 ✅ done.</parameter>\n</invoke>`)];
    const evs = events((await post('/v1/messages', req0())).text); structure(evs); const t = tu(evs); assert.equal(t.length, 1, 'call must be delivered, not a warning');
    const i = inp(evs, t[0]); assert.equal(i.old_string, NL); assert.equal(i.new_string, NL + '\n#4 ✅ done.'); assert(!JSON.stringify(i).includes('parameter') && !JSON.stringify(i).includes('invoke')); assert.equal(stop(evs), 'tool_use');
  },
  async 'invoke-style call (<invoke>/<parameter>) is understood'() {
    script = [msg('<function_calls>\n<invoke name="Read">\n<parameter name="file_path">a.cs</parameter>\n<parameter name="limit">20</parameter>\n</invoke>\n</function_calls>')];
    const evs = events((await post('/v1/messages', req0())).text); structure(evs); const t = tu(evs); assert.equal(t.length, 1); assert.deepEqual(inp(evs, t[0]), { file_path: 'a.cs', limit: 20 });
  },
  async 'C# XML-doc comments inside Edit values survive byte-exact (<param name="x"> ... </param> in code)'() {
    const code = '/// <summary>Does it.</summary>\n/// <param name="chunk">The chunk</param>\n/// <param name="path">A path</param>\n/// <param name="content">The end</param>\nvoid Foo(int chunk, string path) {}';
    script = [msg(`<tool_call name="Edit">\n<param name="file_path">A.cs</param>\n<param name="old_string">\nvoid Foo() {}\n</param>\n<param name="new_string">\n${code}\n</param>\n</tool_call>`)];
    let evs = events((await post('/v1/messages', req0())).text); let t = tu(evs); assert.equal(t.length, 1); let i = inp(evs, t[0]); assert.equal(i.old_string, 'void Foo() {}'); assert.equal(i.new_string, code);
    const tail = '/// <param name="x">y</param>';     // value that legitimately ENDS with </param>
    script = [msg(`<tool_call name="Edit">\n<param name="file_path">A.cs</param>\n<param name="old_string">a</param>\n<param name="new_string">\n${tail}\n</param>\n</tool_call>`)];
    evs = events((await post('/v1/messages', req0())).text); t = tu(evs); i = inp(evs, t[0]); assert.equal(i.new_string, tail);
  },
  async 'cut-off call (no closers at all) is NEVER applied; call with all closers but a missing </tool_call> still is'() {
    const cut = msg('<tool_call name="Write">\n<param name="file_path">a.txt</param>\n<param name="content">\npartial text that was truncated mi');
    script = [cut, cut, cut, cut]; let evs = events((await post('/v1/messages', req0())).text); assert.equal(tu(evs).length, 0); assert(JSON.stringify(evs).includes('could not be run'));
    script = [msg('<tool_call name="Write">\n<param name="file_path">a.txt</param>\n<param name="content">hello</param>')];
    evs = events((await post('/v1/messages', req0())).text); assert.equal(tu(evs).length, 1);
  },
  async 'format failures are retried up to 3x with the ORIGINAL conversation (nothing echoed) and the closing-tag reminder'() {
    seen.length = 0; const bad = msg('<tool_call name="Nope"><param name="a">SECRETCODE</param></tool_call>');
    script = [bad, bad, msg('<tool_call name="Read"><param name="file_path">a</param></tool_call>')];
    const evs = events((await post('/v1/messages', req0())).text); structure(evs); assert.equal(tu(evs).length, 1); assert.equal(seen.length, 3);
    for (const s of seen.slice(1)) { assert(!JSON.stringify(s.body).includes('SECRETCODE'), 'failed text never sent back'); assert(JSON.stringify(s.body.system).includes('Format reminder')); }
  },
  async 'STOPS EARLY: model announces the next step without a call mid-task -> re-asked; a real final answer is NOT re-asked'() {
    const tr = [{ role: 'user', content: 'do the tasks' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }];
    seen.length = 0; script = [msg('Now I\'ll insert the helper method directly above `InForwardStrip` in ChunkManager.cs:'), msg('<tool_call name="Edit"><param name="file_path">a</param><param name="old_string">x</param><param name="new_string">y</param></tool_call>')];
    let evs = events((await post('/v1/messages', req0({ messages: tr }))).text); structure(evs); assert.equal(tu(evs).length, 1); assert.equal(seen.length, 2); assert(JSON.stringify(seen[1].body.system).includes('You stopped without making a tool call'));
    seen.length = 0; script = [msg('All 12 tasks are finished and the self-test is green. Let me know if you want the next batch.')];
    evs = events((await post('/v1/messages', req0({ messages: tr }))).text); assert.equal(tu(evs).length, 0); assert.equal(seen.length, 1); assert.equal(stop(evs), 'end_turn');
    seen.length = 0; script = [msg('Done.')]; evs = events((await post('/v1/messages', req0({ messages: tr }))).text); assert.equal(seen.length, 1);
    seen.length = 0; script = [msg('Next I\'ll fix it.'), msg('Next I\'ll fix it.'), msg('Next I\'ll fix it.')]; evs = events((await post('/v1/messages', req0({ messages: tr }))).text); assert.equal(seen.length, 3, 'capped at 2 extra tries, then delivered'); assert.equal(tu(evs).length, 0);
  },
  async 'user messages that are not mid-loop (a fresh question) are never re-asked'() {
    seen.length = 0; script = [msg('Let me think about that: ')]; const evs = events((await post('/v1/messages', req0())).text); assert.equal(seen.length, 1); assert.equal(tu(evs).length, 0);
  },
  async 'FUZZ: 600 random tag mixes (param/parameter, tool_call/invoke/function_calls, wrong closers, inline/multiline, code with <param> doc comments) -> exact values, no stray tag survives'() {
    let seed = 12345; const rnd = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; }; const pick = a => a[rnd(a.length)];
    const VALUES = ['plain text value', 'multi\nline value\nwith three lines', '/// <summary>Does it.</summary>\n/// <param name="chunk">The chunk</param>\n/// <param name="path">A path</param>\nvoid F(int chunk, string path) { var s = "a\\b"; }',
      '{"a": [1, 2, {"b": "c"}], "d": "e\\n"}', '#11 ✅ (§7 T6), #12 ✅ (§7 T7).', 'if (a < b && c > d) { List<int> x; }', '**bold** `code` <details>x</details>', 'C:\\Users\\Admin\\Desktop\\Universe Builder\\X.cs', 'echo "hi" && dir C:\\x | findstr /i "a"'];
    const WRAP = [['<tool_call name="T">', '</tool_call>'], ['<tool_call name="T">', '</invoke>'], ['<invoke name="T">', '</invoke>'], ['<function_calls>\n<invoke name="T">', '</invoke>\n</function_calls>'], ['<tool_call name="T">', '</function_calls>'], ['<invoke name="T">', '</tool_call>']];
    const CLOSE = ['</param>', '</parameter>', '</parameter>\n</parameter>\n</param>', '</param>\n</param>', '</parameter>\n</param>'];
    const SPECS = [['Edit', ['file_path', 'old_string', 'new_string']], ['Write', ['file_path', 'content']], ['Bash', ['command']]];
    const toolsFuzz = proxy.transform(req0({ tools: [...TOOLS, { name: 'Bash', description: 'b', input_schema: { type: 'object', required: ['command'], properties: { command: { type: 'string' }, timeout: { type: 'number' } } } }] }), 'text').tools;
    for (let n = 0; n < 600; n++) {
      const [tool, names] = pick(SPECS), [wo, wc] = pick(WRAP), tag = pick(['param', 'parameter']), cl = pick(CLOSE), inline = rnd(2) === 0, want = {};
      const parts = names.map(k => { const v = pick(VALUES); want[k] = v; const body = v.includes('\n') || rnd(2) ? `\n${v}\n` : v; return `<${tag} name="${k}">${body}${cl}`; });
      const text = (rnd(2) ? 'Now I\'ll make the change.\n' : '') + wo.replace('"T"', `"${tool}"`) + '\n' + parts.join(inline ? '' : '\n') + '\n' + wc + (rnd(2) ? '\nand some trailing prose' : '');
      if (tool === 'Write' && want.content.includes('\n') && !want.content.endsWith('\n')) want.content += '\n';   // the proxy deliberately ends multi-line Write content with a newline
      const r = proxy.extractCalls(text, toolsFuzz);
      assert.equal(r.errors.length, 0, 'case ' + n + ' errors: ' + JSON.stringify(r.errors) + '\n' + text); assert.equal(r.calls.length, 1, 'case ' + n + '\n' + text);
      assert.deepEqual(r.calls[0].params, want, 'case ' + n + '\n' + text); assert(!r.before.includes('<function_calls>') && !r.before.includes('<invoke') && !r.before.includes('<tool_call'), 'lead text leak, case ' + n);
    }
  },
  async 'TOOL DOCS: the model sees the full Edit/Bash description and every parameter (not just the first sentence); other tools stay compact'() {
    const edit = { name: 'Edit', description: 'Performs exact string replacements in files.\n\nUsage:\n- You must use your Read tool at least once in the conversation before editing.\n- The edit will FAIL if `old_string` is not unique in the file.', input_schema: { type: 'object', required: ['file_path', 'old_string', 'new_string'], properties: { file_path: { type: 'string', description: 'The absolute path to the file to modify' }, old_string: { type: 'string', description: 'The text to replace' }, new_string: { type: 'string', description: 'The text to replace it with (must be different from old_string)' }, replace_all: { type: 'boolean', default: false, description: 'Replace all occurrences of old_string' } } } };
    const other = { name: 'WebFetch', description: 'Fetches a URL. Second sentence should not appear.', input_schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'The URL' } } } };
    const sys = JSON.stringify(proxy.transform({ model: 'm', system: 's', messages: [{ role: 'user', content: 'x' }], tools: [edit, other] }, 'text').payload.system);
    for (const must of ['You must use your Read tool at least once', 'FAIL if', '- file_path (string, required): The absolute path', '- replace_all (boolean, default false): Replace all occurrences', 'must be different from old_string']) assert(sys.includes(must), 'missing: ' + must);
    assert(sys.includes('WebFetch(*url:string) — Fetches a URL.') && !sys.includes('Second sentence should not appear'));
  },
  async 'few-shot bridge check is only added to a fresh conversation, not re-injected once real calls exist'() {
    const fresh = proxy.transform(req0(), 'text').payload.messages; assert(JSON.stringify(fresh).includes('Quick bridge check'));
    const later = [{ role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }];
    assert(!JSON.stringify(proxy.transform(req0({ messages: later }), 'text').payload.messages).includes('Quick bridge check'));
  },
  async 'text before a call never shows <function_calls>; a tool_result the model invented is removed from what you see'() {
    script = [msg('Let me check.\n<function_calls>\n<invoke name="Read">\n<parameter name="file_path">a.cs</parameter>\n</invoke>\n</function_calls>')];
    let evs = events((await post('/v1/messages', req0())).text); const lead = evs.filter(e => e.type === 'content_block_delta' && e.delta.type === 'text_delta').map(e => e.delta.text).join(''); assert.equal(lead.trim(), 'Let me check.'); assert.equal(tu(evs).length, 1);
    script = [msg('The file says:\n<tool_result tool="Read" id="x">\nINVENTED CONTENT\n</tool_result>\nSo we are done.')];
    evs = events((await post('/v1/messages', req0())).text); const txt = JSON.stringify(evs); assert(!txt.includes('INVENTED CONTENT'));
  },
  async 'HALLUCINATION GUARD: "I have edited X" with no Edit/Write/shell call this task -> re-asked once; real edits, other claims and fresh questions are left alone'() {
    const readOnly = [{ role: 'user', content: 'fix it' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'src' }] }];
    seen.length = 0; script = [msg('I have updated ChunkManager.cs with the fix and everything compiles.'), msg('<tool_call name="Edit"><param name="file_path">a</param><param name="old_string">x</param><param name="new_string">y</param></tool_call>')];
    let evs = events((await post('/v1/messages', req0({ messages: readOnly }))).text); assert.equal(tu(evs).length, 1); assert.equal(seen.length, 2); assert(JSON.stringify(seen[1].body.system).includes('described file changes as already made'));
    const withEdit = [...readOnly.slice(0, 2), { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] }];
    seen.length = 0; script = [msg('I have updated ChunkManager.cs with the fix.')]; evs = events((await post('/v1/messages', req0({ messages: withEdit }))).text); assert.equal(seen.length, 1, 'edit really happened: no re-ask'); assert(JSON.stringify(evs).includes('I have updated'));
    seen.length = 0; script = [msg('I verified the file directly; all five edits are on disk.')]; await post('/v1/messages', req0({ messages: readOnly })); assert.equal(seen.length, 1, 'a verification statement is not a claim of new changes');
    seen.length = 0; script = [msg('I have updated my notes.')]; await post('/v1/messages', req0()); assert.equal(seen.length, 1, 'fresh question never re-asked');
  },
  async 'USAGE: cache_read/cache_creation tokens reach Claude Code (its context meter and auto-compact depend on them), streamed and not'() {
    const u = { input_tokens: 5, cache_read_input_tokens: 90000, cache_creation_input_tokens: 2000, output_tokens: 20 };
    script = [msg('hello', { usage: u })]; let evs = events((await post('/v1/messages', req0())).text); const ms = evs.find(e => e.type === 'message_start').message.usage;
    assert.equal(ms.cache_read_input_tokens, 90000); assert.equal(ms.cache_creation_input_tokens, 2000); assert.equal(ms.input_tokens, 5);
    script = [msg('hello', { usage: u })]; const j = JSON.parse((await post('/v1/messages', req0({ stream: false }))).text); assert.equal(j.usage.cache_read_input_tokens, 90000); assert.equal(j.usage.cache_creation_input_tokens, 2000);
  },
  async 'USAGE: a provider that reports (almost) no input tokens gets an estimate, so /compact can still trigger'() {
    script = [msg('hello', { usage: { input_tokens: 0, output_tokens: 10 } })];
    const j = JSON.parse((await post('/v1/messages', req0({ stream: false, messages: [{ role: 'user', content: 'x'.repeat(200000) }] }))).text);
    assert(j.usage.input_tokens > 40000 && j.usage.input_tokens < 90000, 'estimate ~ bytes/3.6, got ' + j.usage.input_tokens);
    script = [msg('hello', { usage: { input_tokens: 30000, output_tokens: 10 } })]; const k = JSON.parse((await post('/v1/messages', req0({ stream: false, messages: [{ role: 'user', content: 'x'.repeat(100000) }] }))).text); assert.equal(k.usage.input_tokens, 30000, 'plausible provider numbers are trusted');
  },
  async 'UPSTREAM_STREAM=1: provider SSE (CRLF, split deltas, thinking+signature, usage) is assembled and delivered as the same native tool_use'() {
    const ev = (n, d) => `event: ${n}\r\ndata: ${JSON.stringify(d)}\r\n\r\n`;
    const call = '<tool_call name="Read">\n<param name="file_path">C:\\a\\b.cs</param>\n</tool_call>';
    const sse = ev('message_start', { type: 'message_start', message: { id: 'msg_s', model: 'm', usage: { input_tokens: 12, cache_read_input_tokens: 4000 } } })
      + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me ' } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think' } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } }) + ev('content_block_stop', { type: 'content_block_stop', index: 0 })
      + ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Reading it.\n' + call.slice(0, 20) } }) + ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: call.slice(20) } }) + ev('content_block_stop', { type: 'content_block_stop', index: 1 })
      + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 33 } }) + ev('message_stop', { type: 'message_stop' });
    process.env.UPSTREAM_STREAM = '1'; seen.length = 0; script = [{ sse }];
    try { const evs = events((await post('/v1/messages', req0({ thinking: { type: 'enabled', budget_tokens: 1000 } }))).text); structure(evs);
      assert.equal(seen[0].body.stream, true, 'provider is asked to stream'); const t = tu(evs); assert.equal(t.length, 1); assert.deepEqual(inp(evs, t[0]), { file_path: 'C:\\a\\b.cs' }); assert.equal(stop(evs), 'tool_use');
      const th = evs.find(e => e.type === 'content_block_delta' && e.delta.type === 'thinking_delta'); assert.equal(th.delta.thinking, 'let me think'); assert(evs.some(e => e.type === 'content_block_delta' && e.delta.type === 'signature_delta' && e.delta.signature === 'SIG'));
      assert.equal(evs.find(e => e.type === 'message_start').message.usage.cache_read_input_tokens, 4000);
    } finally { delete process.env.UPSTREAM_STREAM; }
    assert.equal(proxy.assembleSse('event: error\ndata: {"type":"error","error":{"message":"boom"}}\n\n').error.message, 'boom');
    script = [msg('plain')]; seen.length = 0; await post('/v1/messages', req0()); assert.equal(seen[0].body.stream, false, 'default stays non-streaming');
  },
  async 'TRIM valve: above the limit OLD tool outputs are cut (with a note), the last 10 messages and small outputs are untouched; TRIM_ABOVE_KB=0 disables'() {
    const big = n => 'L' + String(n) + ' ' + 'z'.repeat(30000); const msgs = [{ role: 'user', content: 'do the task' }];
    for (let i = 0; i < 8; i++) { msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'u' + i, name: 'Read', input: { file_path: 'f' + i } }] }); msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u' + i, content: i === 1 ? 'small output' : big(i) }] }); }
    process.env.TRIM_ABOVE_KB = '20';
    try { const out = proxy.transform(req0({ messages: msgs }), 'text').payload.messages; const txt = out.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      assert(txt.slice(0, 7).some(x => x.includes('trimmed by the proxy')), 'old outputs trimmed'); assert(txt.slice(0, 7).every(x => x.length < 6000), 'old outputs are small now'); assert(txt.some(x => x.includes('small output')), 'small output intact');
      assert(txt.slice(-10).some(x => x.includes('z'.repeat(30000))), 'the recent window is untouched'); process.env.TRIM_ABOVE_KB = '0';
      const off = proxy.transform(req0({ messages: msgs }), 'text').payload.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)); assert(!off.some(x => x.includes('trimmed by the proxy')));
      process.env.TRIM_ABOVE_KB = '900'; const under = proxy.transform(req0({ messages: msgs }), 'text').payload.messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)); assert(!under.some(x => x.includes('trimmed by the proxy')), 'below the limit nothing changes');
    } finally { delete process.env.TRIM_ABOVE_KB; }
  },
  async 'HANG FIX: a provider that never answers -> ONE switch to streaming after the timeout (no identical blind retries), then it works; the NEXT request is a normal non-streaming call again (streamed calls cost ~4.7x), unless STREAM_STICKY=1'() {
    const ev = (n, d) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`;
    const sseOf = text => ev('message_start', { type: 'message_start', message: { id: 'm', model: 'm', usage: { input_tokens: 9 } } }) + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) + ev('content_block_stop', { type: 'content_block_stop', index: 0 }) + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) + ev('message_stop', { type: 'message_stop' });
    process.env.UPSTREAM_TIMEOUT_S = '0.3'; seen.length = 0; script = [{ hang: true }, { sse: sseOf('Finished after the fallback.') }]; const t0 = Date.now();
    try { const evs = events((await post('/v1/messages', req0())).text); structure(evs); assert(JSON.stringify(evs).includes('Finished after the fallback.')); assert.equal(seen.length, 2, 'exactly one retry, in streaming mode'); assert.equal(seen[0].body.stream, false); assert.equal(seen[1].body.stream, true); assert(Date.now() - t0 < 5000, 'no multi-minute wait'); assert.equal(proxy.state.stream, false, 'streaming is per request, not sticky');
      script = [{ json: msg('Back to normal calls.').json }]; seen.length = 0; await post('/v1/messages', req0()); assert.equal(seen[0].body.stream, false, 'not sticky by default');
      process.env.STREAM_STICKY = '1'; process.env.UPSTREAM_TIMEOUT_S = '0.3'; script = [{ hang: true }, { sse: sseOf('sticky now') }]; await post('/v1/messages', req0()); script = [{ sse: sseOf('still streaming') }]; seen.length = 0; await post('/v1/messages', req0()); assert.equal(seen[0].body.stream, true, 'sticky when STREAM_STICKY=1');
    } finally { delete process.env.UPSTREAM_TIMEOUT_S; delete process.env.STREAM_STICKY; proxy.state.stream = false; hung.splice(0).forEach(r => r.destroy()); }
  },
  async 'HANG FIX: provider 524 (Cloudflare timeout) -> switch to streaming instead of re-sending the same request'() {
    const ev = (n, d) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`;
    const sse = ev('message_start', { type: 'message_start', message: { id: 'm', model: 'm', usage: { input_tokens: 9 } } }) + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok after 524' } }) + ev('content_block_stop', { type: 'content_block_stop', index: 0 }) + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) + ev('message_stop', { type: 'message_stop' });
    seen.length = 0; script = [{ status: 524, body: 'error code: 524' }, { sse }];
    try { const evs = events((await post('/v1/messages', req0())).text); assert(JSON.stringify(evs).includes('ok after 524')); assert.equal(seen.length, 2); assert.equal(seen[1].body.stream, true); } finally { proxy.state.stream = false; }
    seen.length = 0; script = [{ status: 524, body: 'e' }, { status: 524, body: 'e' }]; proxy.state.stream = false;
    try { const r = await post('/v1/messages', req0()); assert.equal(r.status, 524, 'a second 524 is reported, not looped'); assert.equal(seen.length, 2); } finally { proxy.state.stream = false; }
  },
  async 'RE-ASK GATES: a huge request skips the optional re-asks; a spent time budget stops format retries (each re-ask re-sends everything)'() {
    const tr = [{ role: 'user', content: 'do the tasks' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'a' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }];
    process.env.GUARD_MAX_KB = '1'; seen.length = 0; script = [msg('Now I\'ll insert the helper method:')];
    try { const evs = events((await post('/v1/messages', req0({ messages: tr }))).text); assert.equal(seen.length, 1, 'no continue re-ask on a big request'); assert.equal(tu(evs).length, 0); } finally { delete process.env.GUARD_MAX_KB; }
    process.env.REASK_BUDGET_S = '0'; seen.length = 0; script = [msg('<tool_call name="Nope"><param name="a">1</param></tool_call>')];
    try { const evs = events((await post('/v1/messages', req0())).text); assert.equal(seen.length, 1, 'no format retry once the budget is spent'); assert(JSON.stringify(evs).includes('could not be run')); } finally { delete process.env.REASK_BUDGET_S; }
  },
  async 'HEARTBEAT: while the provider is silent the console says so every HEARTBEAT_S seconds (with size and the /compact hint)'() {
    const ev = (n, d) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`; const lines = []; const orig = console.log; console.log = (...a) => { lines.push(a.join(' ')); };
    const sse = ev('message_start', { type: 'message_start', message: { id: 'm', model: 'm', usage: { input_tokens: 9 } } }) + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }) + ev('content_block_stop', { type: 'content_block_stop', index: 0 }) + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) + ev('message_stop', { type: 'message_stop' });
    process.env.HEARTBEAT_S = '0.1'; process.env.UPSTREAM_TIMEOUT_S = '0.45'; script = [{ hang: true }, { sse }];
    try { await post('/v1/messages', req0()); } finally { console.log = orig; delete process.env.HEARTBEAT_S; delete process.env.UPSTREAM_TIMEOUT_S; proxy.state.stream = false; hung.splice(0).forEach(r => r.destroy()); }
    const hb = lines.filter(l => l.includes('still waiting for the provider')); assert(hb.length >= 2, 'heartbeats: ' + hb.length); assert(/\d+ KB request/.test(hb[0]));
  },
};
(async () => {
  await new Promise(r => mock.listen(18191, '127.0.0.1', r)); await new Promise(r => proxy.server.listen(18192, '127.0.0.1', r));
  const log = console.log; let fail = 0;
  for (const [name, fn] of Object.entries(tests)) { console.log = () => {};
    try { await fn(); console.log = log; log('  ok   ' + name); } catch (e) { console.log = log; fail++; log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 4).join('\n       ')); } }
  log(fail ? `\n${fail} failed` : '\nall passed'); process.exit(fail ? 1 : 0);
})();
