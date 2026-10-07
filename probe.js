'use strict';
/**
 * node probe.js            Find out what YOUR relay really supports, and save it to capabilities.json (the proxy reads it at start).
 *
 * Uses: UPSTREAM_API_KEY (or ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY), TARGET_URL (default https://api.justwoker.icu), ANTHROPIC_MODEL.
 * Costs a handful of tiny requests. The key is never printed or saved.
 *   1. models offered            2. which tool names the relay passes natively (capitalized vs lowercase, plus a candidate list)
 *   3. a full native round trip  4. vision (a tiny red PNG)   5. thinking parameter   6. streaming
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CANDIDATES = ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'ls', 'list', 'find', 'search', 'web_search', 'web_fetch', 'fetch', 'todo_write', 'task', 'multi_edit', 'notebook_edit', 'view', 'shell', 'run', 'python', 'str_replace', 'create'];
const CLIENT_NAME = { read: 'Read', write: 'Write', edit: 'Edit', bash: 'Bash', grep: 'Grep', glob: 'Glob', ls: 'LS', web_search: 'WebSearch', web_fetch: 'WebFetch', todo_write: 'TodoWrite', multi_edit: 'MultiEdit', notebook_edit: 'NotebookEdit' };

function redPng() {   // 16x16 solid red PNG, built here so no file is needed
  const w = 16, h = 16, raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 255; raw[o + 1] = 0; raw[o + 2] = 0; } }
  const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function runProbe({ base, key, model, log = console.log, write = true, dir = __dirname } = {}) {
  const hdr = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key, authorization: `Bearer ${key}` };
  const call = async (body, timeout = 120) => { try { const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: hdr, body: JSON.stringify({ model, max_tokens: 400, ...body }), signal: AbortSignal.timeout(timeout * 1000) }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* sse or html */ } return { status: r.status, text, json, ct: r.headers.get('content-type') || '' }; } catch (e) { return { status: 0, text: String(e.message), json: null, ct: '' }; } };
  const blocks = r => (r.json && Array.isArray(r.json.content)) ? r.json.content : [];
  const txt = r => blocks(r).filter(b => b.type === 'text').map(b => b.text).join(' ');
  const toolUse = r => blocks(r).filter(b => b.type === 'tool_use');
  const schema = { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' } } };
  const mk = name => ({ name, description: `Reads a file. Call it with file_path.`, input_schema: schema });
  const out = { ts: new Date().toISOString(), base, model, models: [], native: { works: false, map: {}, names: [] }, vision: false, thinking: false, stream: false };

  log('1. models offered');
  try { const r = await fetch(`${base}/v1/models`, { headers: hdr, signal: AbortSignal.timeout(30000) }); const j = await r.json(); out.models = (j.data || []).map(m => m.id); log('   ' + (out.models.join(', ') || '(none listed)')); } catch (e) { log('   could not list models: ' + e.message); }

  log('2. which tool names does the relay pass natively?');
  for (const name of ['Read', 'read']) {
    const r = await call({ tools: [mk(name)], tool_choice: { type: 'any' }, messages: [{ role: 'user', content: 'Call the tool on the file README.md.' }] });
    const used = toolUse(r).map(b => b.name); const ok = used.includes(name);
    log(`   "${name}": ${r.status !== 200 ? 'HTTP ' + r.status : ok ? 'PASSED natively' : 'ignored/replaced (model used: ' + (used.join(', ') || 'no tool') + ')'}`);
    if (name === 'read' && ok) out.native.works = true;
  }
  const lst = await call({ tools: CANDIDATES.map(n => ({ name: n, description: `tool ${n}`, input_schema: { type: 'object', properties: { input: { type: 'string' } } } })), messages: [{ role: 'user', content: 'List the exact names of every tool available to you, comma separated, nothing else.' }] });
  const said = new Set(txt(lst).split(/[,\n]/).map(x => x.trim().replace(/[`*\-.\s]/g, '')));
  out.native.names = CANDIDATES.filter(n => said.has(n)); log('   names the model reports having: ' + (out.native.names.join(', ') || '(none)'));
  for (const n of out.native.names) if (CLIENT_NAME[n]) out.native.map[CLIENT_NAME[n]] = n;
  if (out.native.works && !out.native.map.Read) out.native.map.Read = 'read';

  log('3. native round trip (tool_use -> tool_result -> answer)');
  if (out.native.works) {
    const r = await call({ tools: [mk('read')], messages: [{ role: 'user', content: 'Read README.md and tell me the secret word in it.' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_probe1', name: 'read', input: { file_path: 'README.md' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_probe1', content: 'The secret word is PINEAPPLE-7.' }] }] });
    const ok = r.status === 200 && /PINEAPPLE/i.test(txt(r)); log(`   ${ok ? 'OK: the relay accepts native tool_use/tool_result history' : 'FAILED (HTTP ' + r.status + '): ' + txt(r).slice(0, 80)}`); if (!ok) out.native.works = false;
  } else log('   skipped (no native tool call worked)');

  log('4. vision');
  const v = await call({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: redPng().toString('base64') } }, { type: 'text', text: 'What single colour is this image? One word.' }] }] });
  out.vision = v.status === 200 && /red/i.test(txt(v)); log(`   ${out.vision ? 'OK: the model can see images' : 'NO (HTTP ' + v.status + '): ' + (txt(v) || v.text).slice(0, 80)}`);

  log('5. thinking parameter');
  const th = await call({ max_tokens: 2000, thinking: { type: 'enabled', budget_tokens: 1024 }, messages: [{ role: 'user', content: 'What is 17 * 23?' }] });
  out.thinking = th.status === 200 && blocks(th).some(b => b.type === 'thinking'); log(`   ${out.thinking ? 'OK: thinking blocks are returned' : th.status === 200 ? 'accepted but no thinking block came back' : 'rejected (HTTP ' + th.status + ')'}`);

  log('6. streaming');
  const st = await call({ stream: true, messages: [{ role: 'user', content: 'Say hi.' }] });
  out.stream = st.status === 200 && /event-stream/.test(st.ct); log(`   ${out.stream ? 'OK (note: on this relay streamed calls were billed ~4.7x, so the proxy only streams when it must)' : 'not supported (HTTP ' + st.status + ')'}`);

  if (write) { fs.writeFileSync(path.join(dir, 'capabilities.json'), JSON.stringify(out, null, 2)); log('\nSaved capabilities.json. Restart the proxy to use it.'); }
  return out;
}

module.exports = { runProbe, redPng };
if (require.main === module) {
  const key = process.env.UPSTREAM_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  if (!key) { console.log('Set UPSTREAM_API_KEY (or ANTHROPIC_AUTH_TOKEN) first.'); process.exit(1); }
  runProbe({ base: (process.env.TARGET_URL || 'https://api.justwoker.icu').replace(/\/$/, ''), key, model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8' }).catch(e => { console.log('probe failed:', e.message); process.exit(1); });
}
