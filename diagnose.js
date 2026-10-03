'use strict';
// Probes the provider DIRECTLY (not through the proxy) to see why the model ignores text tools.
//   $env:ANTHROPIC_AUTH_TOKEN="<your key>"; $env:MODEL="<model name you use in Claude Code>"; node diagnose.js
const https = require('node:https'), http = require('node:http');
const { buildInjection } = require('./alias-proxy.js');
const T = new URL(process.env.TARGET_URL || 'https://api.justwoker.icu');
const KEY = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY, MODEL = process.env.MODEL;
if (!KEY || !MODEL) { console.log('Set ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) and MODEL first.'); process.exit(1); }
const tools = [{ name: 'Read', description: 'Reads a file from the local filesystem.', input_schema: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' } } } }];
const inj = buildInjection(tools);
const ask = (system, user) => new Promise(res => {
  const body = JSON.stringify({ model: MODEL, max_tokens: 600, ...(system ? { system } : {}), messages: [{ role: 'user', content: user }] });
  const r = (T.protocol === 'http:' ? http : https).request({ hostname: T.hostname, port: T.port || 443, path: '/v1/messages', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-api-key': KEY, authorization: 'Bearer ' + KEY, 'anthropic-version': '2023-06-01' } },
    rs => { let t = ''; rs.setEncoding('utf8'); rs.on('data', d => t += d); rs.on('end', () => { try { res((JSON.parse(t).content || []).map(b => b.text || '').join('')); } catch { res(`[HTTP ${rs.statusCode}] ${t.slice(0, 300)}`); } }); });
  r.on('error', e => res('[error] ' + e.message)); r.end(body);
});
(async () => {
  console.log('\nA) No tools, no system prompt. Which functions does the model say it has?');
  console.log((await ask(null, 'List the exact names of every function/tool you can call right now. Names only.')).slice(0, 500));
  const q = 'Read the file C:\\Users\\Admin\\notes.md and tell me what is in it.';
  const hasCall = t => /<tool_call[\s>]/.test(t);
  const b = await ask(inj, q);   console.log('\nB) Our instructions in system prompt only:\n  ' + (hasCall(b) ? 'PASS - emitted <tool_call>' : 'FAIL - no call') + '\n  ' + b.replace(/\s+/g, ' ').slice(0, 300));
  const c = await ask(inj, q + '\n\n[proxy] Your real tools (executed by the user\'s local software from your TEXT): Read. Write <tool_call name="Read"><param name="file_path">...</param></tool_call> as plain text.');
  console.log('\nC) Plus reminder in the user message:\n  ' + (hasCall(c) ? 'PASS - emitted <tool_call>' : 'FAIL - no call') + '\n  ' + c.replace(/\s+/g, ' ').slice(0, 300));
  console.log('\nVerdict:');
  if (hasCall(b) || hasCall(c)) console.log('  Model CAN follow the text protocol on a minimal request -> problem is Claude Code\'s large prompt/history; send me the output.');
  else console.log('  Model refuses even on a minimal request -> the provider layer overrides text tools; a proxy cannot fix this. Use a provider/endpoint that passes native tools.');
})();
