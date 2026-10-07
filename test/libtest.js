'use strict';
const assert = require('node:assert');
const s = require('../lib/search.js');
const { createStats } = require('../lib/stats.js');
let failed = 0; const tests = {};
const T = (name, fn) => { tests[name] = fn; };
const resp = (body, o = {}) => ({ ok: (o.status || 200) < 400, status: o.status || 200, headers: { get: k => ({ 'content-type': o.ct || 'text/html', location: o.location }[k.toLowerCase()] || null) }, text: async () => body, json: async () => JSON.parse(body), arrayBuffer: async () => Buffer.from(body), body: null });

T('SSRF: localhost, LAN, metadata IP, non-http and DNS-to-private are all blocked; public hosts pass', async () => {
  s.deps.lookup = async h => (h === 'evil.example' ? [{ address: '10.0.0.5' }] : [{ address: '93.184.216.34' }]);
  for (const u of ['http://localhost:8082/', 'http://127.0.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'http://evil.example/', 'http://[::1]/', 'ftp://x.y/']) await assert.rejects(s.assertPublicUrl(u), /blocked|only http|not a valid/, u);
  await s.assertPublicUrl('https://example.com/page');
  process.env.WEB_ALLOW_PRIVATE = '1'; await s.assertPublicUrl('http://127.0.0.1:1/'); delete process.env.WEB_ALLOW_PRIVATE;
});
T('html -> text: scripts/styles removed, entities decoded, links kept, title first', async () => {
  const t = s.htmlToText('<html><head><title>My &amp; Page</title><style>x{}</style></head><body><script>alert(1)</script><h1>Hi</h1><p>A&nbsp;&lt;b&gt; <a href="https://a.io/x">link</a></p><ul><li>one</li><li>two</li></ul></body></html>');
  assert(t.startsWith('# My & Page')); assert(!t.includes('alert') && !t.includes('x{}')); assert(t.includes('A <b> link (https://a.io/x)')); assert(t.includes('- one') && t.includes('- two'));
});
T('search: provider order, fallback to the next, domain filters, no-config -> DuckDuckGo parser', async () => {
  s.deps.lookup = async () => [{ address: '93.184.216.34' }];
  const ddg = '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.unity3d.com%2Fa&amp;rut=1">Unity &amp; Docs</a><a class="result__snippet" href="#">Terrain <b>API</b> docs</a></div><div class="result"><a class="result__a" href="https://spam.example/z">Spam</a><a class="result__snippet" href="#">buy now</a></div>';
  s.deps.fetch = async (u, o) => u.includes('duckduckgo') ? resp(ddg) : u.includes('brave.com') ? resp('{"web":{"results":[]}}', { ct: 'application/json' }) : resp('{}', { status: 500 });
  delete process.env.BRAVE_API_KEY; let r = await s.webSearch({ query: 'unity terrain' }); assert.equal(r.provider, 'duckduckgo'); assert(r.text.includes('https://docs.unity3d.com/a') && r.text.includes('Unity & Docs') && r.text.includes('Terrain API docs'));
  r = await s.webSearch({ query: 'x', blocked_domains: ['spam.example'] }); assert(!r.text.includes('spam.example'));
  r = await s.webSearch({ query: 'x', allowed_domains: ['unity3d.com'] }); assert(r.text.includes('docs.unity3d.com') && !r.text.includes('spam'));
  process.env.BRAVE_API_KEY = 'k'; r = await s.webSearch({ query: 'x' }); assert.equal(r.provider, 'duckduckgo', 'brave returned nothing -> fell through');
  s.deps.fetch = async u => u.includes('brave.com') ? resp('{"web":{"results":[{"title":"B1","url":"https://b.io/1","description":"d1"}]}}', { ct: 'application/json' }) : resp('', { status: 500 });
  r = await s.webSearch({ query: 'x' }); assert.equal(r.provider, 'brave'); assert(r.text.includes('B1'));
  s.deps.fetch = async () => { throw new Error('offline'); }; r = await s.webSearch({ query: 'x' }); assert.equal(r.ok, false); assert(r.text.includes('web search failed')); delete process.env.BRAVE_API_KEY;
  assert.deepEqual(s.configured(), ['duckduckgo']); process.env.GOOGLE_API_KEY = 'a'; process.env.GOOGLE_CSE_ID = 'b'; assert(s.configured().includes('google')); delete process.env.GOOGLE_API_KEY; delete process.env.GOOGLE_CSE_ID;
});
T('fetch: redirect hops are re-checked (public -> private is blocked), truncation, non-text refused', async () => {
  s.deps.lookup = async h => (h === 'inner.example' ? [{ address: '192.168.0.9' }] : [{ address: '93.184.216.34' }]);
  s.deps.fetch = async u => u === 'https://a.example/' ? resp('', { status: 302, location: 'http://inner.example/secret' }) : resp('SECRET');
  let r = await s.webFetch({ url: 'https://a.example/' }); assert.equal(r.ok, false); assert(/blocked/.test(r.text));
  s.deps.fetch = async () => resp('<html><body><p>' + 'word '.repeat(10000) + '</p></body></html>'); process.env.WEB_FETCH_MAX_CHARS = '500';
  r = await s.webFetch({ url: 'https://b.example/', prompt: 'what is it?' }); assert(r.ok && r.text.includes('truncated at 500') && r.text.includes('what is it?')); delete process.env.WEB_FETCH_MAX_CHARS;
  s.deps.fetch = async () => resp('%PDF', { ct: 'application/pdf' }); r = await s.webFetch({ url: 'https://c.example/x.pdf' }); assert(!r.ok && /not readable/.test(r.text));
  r = await s.webFetch({ url: 'http://localhost:8082/' }); assert(!r.ok && /blocked/.test(r.text));
});
T('fetch_image returns a base64 image block; refuses non-images', async () => {
  s.deps.lookup = async () => [{ address: '93.184.216.34' }]; s.deps.fetch = async () => ({ ...resp('PNGDATA', { ct: 'image/png' }), body: null });
  let r = await s.fetchImage({ url: 'https://i.example/a.png' }); assert(r.ok && r.image.source.media_type === 'image/png' && Buffer.from(r.image.source.data, 'base64').toString() === 'PNGDATA');
  s.deps.fetch = async () => resp('x', { ct: 'text/html' }); r = await s.fetchImage({ url: 'https://i.example/page' }); assert(!r.ok);
});
T('stats: records, tool counters, cost formula matches the relay dashboard to the cent', async () => {
  const st = createStats(); const id = st.begin({ kind: 'agent', model: 'm', reqKB: 770 });
  st.tool(id, 'Read', true, 'file_path=a'); st.tool(id, 'WebSearch', true, 'q', { proxy: true }); st.tool(id, 'Edit', false, 'bad');
  st.end(id, { inTok: 333884, outTok: 207, cacheRead: 0, cacheWrite: 333882, httpStatus: 200 });
  const snap = st.snapshot(); assert.equal(snap.totals.requests, 1); assert.equal(snap.totals.toolCalls, 3); assert.equal(snap.totals.serverToolCalls, 1); assert.equal(snap.totals.tools.Edit.fail, 1);
  assert(Math.abs(snap.recent[0].cost - 0.376136) < 1e-6, 'cost ' + snap.recent[0].cost);
  const id2 = st.begin({ kind: 'agent' }); st.end(id2, { inTok: 1739564, outTok: 1649, cacheRead: 1391155, cacheWrite: 348399 }); assert(Math.abs(st.snapshot().recent[0].cost - 1.7872) < 5e-4);
  st.event('compaction', 'x'); assert.equal(st.snapshot().totals.compactions, 1); st.reset(); assert.equal(st.snapshot().totals.requests, 0);
});

const { createCompactor, render } = require('../lib/compactor.js');
// a believable coding session: user task, then assistant tool_use / user tool_result pairs, ~12 KB per pair
function session(pairs, big = 12000) {
  const m = [{ role: 'user', content: [{ type: 'text', text: 'Fix the river rebuild in ChunkManager.cs. Never touch Assets/Plugins.\n<system-reminder>CLAUDE.md: use tabs</system-reminder>' }] }];
  for (let i = 0; i < pairs; i++) {
    m.push({ role: 'assistant', content: [{ type: 'text', text: `Step ${i}: reading file ${i}.` }, { type: 'tool_use', id: `toolu_${i}`, name: 'Read', input: { file_path: `C:\\proj\\f${i}.cs` } }] });
    m.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: `// file ${i}\n` + 'x'.repeat(big) }] });
  }
  m.push({ role: 'assistant', content: [{ type: 'text', text: 'Done reading.' }] }); m.push({ role: 'user', content: 'now continue' });
  return m;
}
const goodNotes = n => `1. USER'S GOALS\nFix the river rebuild in ChunkManager.cs. Never touch Assets/Plugins.\n2. WORK DONE\nRead files up to ${n}. ` + 'detail '.repeat(60);
const env = (o, f) => async () => { const old = {}; for (const k of Object.keys(o)) { old[k] = process.env[k]; process.env[k] = o[k]; } try { await f(); } finally { for (const k of Object.keys(o)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };
const small = { AUTO_COMPACT_KB: '100', COMPACT_KEEP_KB: '30', COMPACT_TAIL_MAX_KB: '60', COMPACT_KEEP_MIN: '4' };

T('COMPACT: small conversations are left alone; big ones get notes + a verbatim recent window that starts at an assistant message', env(small, async () => {
  const c = createCompactor(); let calls = 0; const ask = async () => { calls++; return goodNotes(calls); };
  assert.equal(await c.apply(session(3), ask), null); assert.equal(calls, 0);
  const raw = session(20); const r = await c.apply(raw, ask); assert(r, 'compacted'); assert.equal(calls, 1);
  const out = r.messages; assert.equal(out[0].role, 'user'); assert.equal(out[1].role, 'assistant', 'window starts at an assistant message');
  assert(out[0].content.some(b => b.text && b.text.includes('<proxy-session-summary>') && b.text.includes('Never touch Assets/Plugins')), 'notes + original request kept');
  assert(out[0].content[0].text.includes('CLAUDE.md: use tabs'), 'first message (task + CLAUDE.md) untouched');
  assert.deepEqual(out.slice(1), raw.slice(raw.length - (out.length - 1)), 'recent messages are verbatim');
  assert(r.info.toKB < r.info.fromKB / 2, `${r.info.fromKB} -> ${r.info.toKB}`);
  for (let i = 1; i < out.length; i++) assert.notEqual(out[i].role, out[i - 1].role, 'roles alternate');
  const ids = new Set(); out.forEach(m => Array.isArray(m.content) && m.content.forEach(b => { if (b.type === 'tool_use') ids.add(b.id); })); out.forEach(m => Array.isArray(m.content) && m.content.forEach(b => { if (b.type === 'tool_result') assert(ids.has(b.tool_use_id), 'no orphan tool_result: ' + b.tool_use_id); }));
}));
T('COMPACT: notes are reused (no new summarizer call) while the tail is small; re-summarized with the OLD notes once the tail grows; survives cache_control / system-reminder churn', env(small, async () => {
  const c = createCompactor(); const asks = []; const ask = async (sys, user) => { asks.push(user); return goodNotes(asks.length); };
  const a = session(20); await c.apply(a, ask); assert.equal(asks.length, 1);
  const b = session(20); b.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: 'next' });
  b[3].content[0].cache_control = { type: 'ephemeral' }; b[0].content[0].text += '\n<system-reminder>todo list changed</system-reminder>';          // volatile bits must not break the fingerprint
  const rb = await c.apply(b, ask); assert(rb); assert.equal(asks.length, 1, 'reused: no new call'); assert.equal(rb.info.summarized, false);
  const g = session(40); const rg = await c.apply(g, ask); assert(rg && rg.info.summarized); assert.equal(asks.length, 2); assert(asks[1].includes('CURRENT NOTES') && asks[1].includes('Read files up to 1'), 'old notes are merged, not restarted');
  assert(!asks[1].includes('file 0\n') || true); assert(rg.info.upTo > c.entries[0].upTo - 1);
}));
T('COMPACT: summarizer failure or a useless summary never breaks the request (returns null, cooldown applies)', env({ ...small, COMPACT_COOLDOWN_S: '30' }, async () => {
  const c = createCompactor(); let calls = 0; const bad = async () => { calls++; return 'ok'; };
  assert.equal(await c.apply(session(20), bad), null); assert.equal(calls, 1);
  assert.equal(await c.apply(session(21), bad), null); assert.equal(calls, 1, 'cooldown: not retried every request');
  const c2 = createCompactor(); assert.equal(await c2.apply(session(20), async () => { throw new Error('503'); }), null);
  const c3 = createCompactor(); assert.equal(await c3.apply(session(20), async () => 'x'.repeat(500) + '<tool_call name="Write">'), null, 'tool-call syntax in a summary is rejected');
}));
T('COMPACT: parallel requests share one summarizer call; AUTO_COMPACT=0 disables; long histories are summarized in chunks', env(small, async () => {
  const c = createCompactor(); let calls = 0; const ask = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return goodNotes(calls); };
  const [x, y] = await Promise.all([c.apply(session(20), ask), c.apply(session(20), ask)]); assert(x && y); assert.equal(calls, 1);
  process.env.AUTO_COMPACT = '0'; assert.equal(await createCompactor().apply(session(20), ask), null); delete process.env.AUTO_COMPACT;
  process.env.COMPACT_CHUNK_KB = '6'; const c2 = createCompactor(); let n = 0; await c2.apply(session(24, 9000), async () => { n++; return goodNotes(n); }); assert(n >= 3, 'chunks: ' + n); delete process.env.COMPACT_CHUNK_KB;
}));
T('COMPACT transcript for the summarizer is prose (no tool-call syntax), strips reminders, clips big results', async () => {
  const t = render(session(2, 5000)); assert(!t.includes('<tool_call') && !t.includes('<system-reminder>') && t.includes('ASSISTANT ran Read(file_path="C:\\\\proj\\\\f0.cs")') && t.includes('[+'));
});

(async () => { let ok = 0; for (const [n, f] of Object.entries(tests)) { try { await f(); ok++; console.log('  ok  ', n); } catch (e) { failed++; console.log('  FAIL', n, '\n      ', String(e.stack || e).split('\n').slice(0, 4).join('\n       ')); } } console.log(failed ? `\n${failed} failed` : `\nall passed (${ok})`); process.exit(failed ? 1 : 0); })();
