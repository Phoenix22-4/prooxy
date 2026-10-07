'use strict';
/**
 * Claude Code text-emulation proxy  v2.7  (your design, fixed)
 * Same technology as before: Claude Code -> this proxy -> provider with stream=false, tools described as text,
 * model answers with <tool_call> text, proxy converts it into native tool_use SSE events for Claude Code.
 *
 *   node alias-proxy.js        (Claude Code uses ANTHROPIC_BASE_URL=http://127.0.0.1:8082)
 * Env: PORT, TARGET_URL, PROXY_DEBUG=1, KEEP_MCP=mcp__prefix, EXTRA_TOOLS=A,B, DROP_TOOLS=A,B, UPSTREAM_STREAM=1, UPSTREAM_TIMEOUT_S=180, REASK_BUDGET_S=150, GUARD_MAX_KB=300, TRIM_ABOVE_KB=400, FORMAT_RETRIES=3, CONTINUE_GUARD=0, HALLUCINATION_GUARD=0, TOOL_DETAIL=compact,  FEWSHOT=0
 */
const http   = require('node:http');
const https  = require('node:https');
const crypto = require('node:crypto');
const fs     = require('node:fs');
const path   = require('node:path');
const { createStats } = require('./lib/stats.js');
const search = require('./lib/search.js');
const { createCompactor } = require('./lib/compactor.js');

const PORT      = +(process.env.PORT || 8082);
const TARGET    = new URL(process.env.TARGET_URL || 'https://api.justwoker.icu');
const transport = TARGET.protocol === 'http:' ? http : https;
const DEBUG     = process.env.PROXY_DEBUG === '1';
const FORMAT_RETRIES = +(process.env.FORMAT_RETRIES ?? 3);
const CONT_RETRIES   = process.env.CONTINUE_GUARD === '0' ? 0 : +(process.env.CONTINUE_RETRIES ?? 2);   // re-ask when the model stops mid-task without a tool call
const FMT_NOTE  = 'Format reminder: write each parameter as <param name="..."> ... </param> and end the call with </tool_call>. Do not use </parameter>, <invoke> or </invoke>.';
const CONT_NOTE = 'You stopped without making a tool call while the task is still in progress. Do not describe the next step: make the tool call for it now. Only stop when every item the user asked for is done.';
const UP_RETRIES     = +(process.env.UP_RETRIES ?? 3);
const FEWSHOT        = process.env.FEWSHOT !== '0';
const RICH_DOCS      = process.env.TOOL_DETAIL !== 'compact';   // full descriptions + per-parameter docs for the file/shell tools (what native Claude Code shows the model)
const HALL_RETRIES   = process.env.HALLUCINATION_GUARD === '0' ? 0 : 1;
const HALL_NOTE = 'You described file changes as already made, but no Edit/Write tool call was made in this task. If a change is needed, make the tool call now. If not, say plainly that nothing was changed.';
const BUILD = '2026-10-07';
const VERSION = '3.0';
const CALL_FORMAT    = process.env.CALL_FORMAT === 'json' ? 'json' : 'xml';   // how the model is told to write calls (the parser accepts both)
// TRANSPORT: auto = text bridge first, then the system_todo_write tunnel if the model ignores it | text | tunnel
const opts  = { TRANSPORT: ['text', 'tunnel'].includes(process.env.TRANSPORT) ? process.env.TRANSPORT : 'auto' };
const envNum = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : +process.env[k]);
const state = { tunnel: false, fmt: null, stream: false, native: null, nativeFails: 0, mainModel: '', badModels: new Set() };   // fmt: sticky call format once JSON proved unreliable for code
const FAKE_TOOLS = new Set(['read_tabular', 'system_todo_write']);
const FAKE_RE    = /read_tabular|system_todo_write/;
const REFUSAL_RE = /(?:do(?:n't| not)(?: actually)? have|no|not|cannot|can't|unable to|isn't|aren't|wasn't)\b[^.\n]{0,90}\b(?:tools?|Bash|Edit|Write|Read|Glob|Grep|PowerShell|file access|wired|exposed)\b|\b(?:wired|exposed) to me\b/i;
const KEEP_MCP   = (process.env.KEEP_MCP || '').split(',').map(s => s.trim()).filter(Boolean);
const CORE_TOOLS = new Set(['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'fetch_image', 'TodoWrite', 'TodoRead', 'Task', 'Agent', 'Skill', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  'BashOutput', 'KillShell', 'TaskStop', 'Monitor', 'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'EnterWorktree', 'ExitWorktree', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', ...(process.env.EXTRA_TOOLS || '').split(',').map(s => s.trim()).filter(Boolean)]);

const log  = (...a) => console.log('[Proxy]', ...a);
const dbg  = (...a) => DEBUG && console.log('[Proxy:dbg]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dash = createStats();                                   // dashboard statistics (served at http://127.0.0.1:PORT/)
const compactor = createCompactor({ log: (...a) => log(...a), onEvent: (t, txt) => dash.event(t, txt) });
const DASH_HTML = (() => { try { return fs.readFileSync(path.join(__dirname, 'lib', 'dashboard.html'), 'utf8'); } catch { return '<h1>lib/dashboard.html is missing</h1>'; } })();
const KEEP_CACHE = process.env.KEEP_CACHE === '1';           // default: cache_control is stripped (this relay bills cached tokens twice, see README)
const noCache = v => (v === undefined ? v : JSON.parse(JSON.stringify(v, (k, x) => (k === 'cache_control' ? undefined : x))));
const estTokens = s => Math.ceil(String(s).length / 3.6);
const stats = { calls: 0, extra: { format: 0, continue: 0, claim: 0, firewall: 0 }, inTok: 0, outTok: 0 };
function usageTotals(data) {   // provider numbers -> { total, read, write, uncached, out }
  const u = (data && data.usage) || {}, read = u.cache_read_input_tokens || 0, write = u.cache_creation_input_tokens || 0, inp = u.input_tokens || 0;
  const inclusive = read + write > 0 && inp >= read + write && inp - read - write <= Math.max(1000, 0.1 * inp);   // this relay: input_tokens = everything (cached included)
  return { total: inclusive ? inp : inp + read + write, read, write, uncached: inclusive ? inp - read - write : inp, out: u.output_tokens || 0 };
}
function reportUsage(data, outTok, reqBytes) {   // what Claude Code is told about context size: drives its context meter
  const t = usageTotals(data), est = Math.ceil((reqBytes || 0) / 3.6);
  if (est && t.total < est * 0.25) return { input_tokens: est, output_tokens: outTok, estimated: true };   // provider reported (almost) nothing: use our estimate
  const out = { input_tokens: t.uncached, output_tokens: outTok }; if (t.read) out.cache_read_input_tokens = t.read; if (t.write) out.cache_creation_input_tokens = t.write; return out;
}
const createSse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------- JSON repair (Windows paths, raw newlines, trailing commas)
function sanitize(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { out += ch; esc = false; }
      else if (ch === '\\') { out += ch; esc = true; }
      else if (ch === '"') { out += ch; inStr = false; }
      else if (ch === '\n') out += '\\n'; else if (ch === '\r') out += '\\r'; else if (ch === '\t') out += '\\t';
      else out += ch;
    } else { if (ch === '"') inStr = true; out += ch; }
  }
  return out;
}
function balance(s) {
  const st = []; let inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true; else if (ch === '{') st.push('}'); else if (ch === '[') st.push(']');
    else if ((ch === '}' || ch === ']') && st.length) st.pop();
  }
  return s + (inStr ? '"' : '') + st.reverse().join('');
}
const noTrail = s => s.replace(/,\s*([}\]])/g, '$1');
// Windows paths like "C:\Users\Admin" are invalid JSON escapes: double any backslash that does not start a valid escape
const fixPathSlashes = s => s.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
function repairJson(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim(); const f = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/); if (f) s = f[1];
  const tries = [x => x, sanitize, x => fixPathSlashes(sanitize(x)), x => noTrail(fixPathSlashes(sanitize(x))), x => noTrail(balance(fixPathSlashes(sanitize(x))))];
  for (const t of tries) { try { return JSON.parse(t(s)); } catch { /* next */ } }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(noTrail(fixPathSlashes(sanitize(s.slice(a, b + 1))))); } catch { /* give up */ } }
  return null;
}

// ---------------------------------------------------------------- tool docs from the REAL schemas Claude Code sends
function typeStr(s, d = 0) {
  if (!s || typeof s !== 'object') return 'any';
  if (Array.isArray(s.enum)) return s.enum.map(v => JSON.stringify(v)).join('|');
  const t = Array.isArray(s.type) ? s.type.filter(x => x !== 'null').join('|') : s.type;
  if (t === 'array') { const it = s.items; return it && it.type === 'object' && it.properties && d < 2 ? `[{${propList(it, d + 1)}}]` : `${typeStr(it, d + 1)}[]`; }
  if (t === 'object' && s.properties && d < 2) return `{${propList(s, d + 1)}}`;
  return t || 'any';
}
function propList(sc, d) { const req = new Set(sc.required || []); return Object.entries(sc.properties || {}).map(([k, v]) => `${req.has(k) ? '*' : ''}${k}:${typeStr(v, d)}`).join(', '); }
const RICH_TOOLS = new Set(['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'NotebookEdit']);
function richDoc(t) {   // the same facts native Claude Code gives the model: full description (capped) + every parameter with its type, enum, default and description
  const sc = t.input_schema || {}, req = new Set(sc.required || []);
  let d = String(t.description || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); if (d.length > 1500) d = d.slice(0, 1499) + '…';
  const lines = Object.entries(sc.properties || {}).map(([k, v]) => {
    const desc = String((v && v.description) || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    return `  - ${k} (${typeStr(v, 1)}${req.has(k) ? ', required' : ''}${v && v.default !== undefined ? ', default ' + JSON.stringify(v.default) : ''})${desc ? ': ' + desc : ''}`;
  });
  return `### ${t.name}\n${d}\n${lines.join('\n')}`;
}
function toolDoc(t) {
  if (RICH_DOCS && RICH_TOOLS.has(t.name)) return richDoc(t);
  const d = String(t.description || '').replace(/\s+/g, ' ').trim();
  let first = d.split(/(?<=[.!?])\s/)[0] || ''; if (first.length > 110) first = first.slice(0, 109) + '…';
  return `${t.name}(${propList(t.input_schema || {}, 0)})${first ? ' — ' + first : ''}`;
}
const DROP_TOOLS = new Set((process.env.DROP_TOOLS || '').split(',').map(x => x.trim()).filter(Boolean));   // opt-in: e.g. AskUserQuestion,EnterPlanMode so the model can't pause itself
function selectTools(tools, choice) {
  const all = (tools || []).filter(t => t && t.name && !FAKE_TOOLS.has(t.name) && !DROP_TOOLS.has(t.name));
  const core = all.filter(t => CORE_TOOLS.has(t.name) || (t.name.startsWith('mcp__') && KEEP_MCP.some(p => t.name.startsWith(p))));
  const forced = choice && choice.type === 'tool' ? all.find(t => t.name === choice.name) : null;
  if (forced && !core.includes(forced)) core.push(forced);             // the client demanded this tool: it must reach the model
  if (!core.length && all.length && all.length <= 4) return all;       // side-request (auto-mode safety check, title, ...) carrying its own small tool set
  return core;
}

// Native tool channel. The relay only forwards tools whose names are exactly these lowercase ones (confirmed by the
// ccproxy author's names_probe); every other tool still goes through the text bridge. node probe.js finds more names.
const CAP = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'capabilities.json'), 'utf8')); } catch { return {}; } })();
if (CAP.native && typeof CAP.native.works === 'boolean') state.native = CAP.native.works ? 'on' : 'off';
const nativeMode = () => (process.env.NATIVE_TOOLS === '0' ? 'off' : process.env.NATIVE_TOOLS === '1' ? 'on' : 'auto');
function nativeMap() {
  let extra = {}; try { extra = process.env.NATIVE_MAP ? JSON.parse(process.env.NATIVE_MAP) : {}; } catch { /* ignore */ }
  const m = { Read: 'read', Write: 'write', Edit: 'edit', Bash: 'bash', ...((CAP.native && CAP.native.map) || {}), ...extra };
  // Never send proxy-run web tools through the native channel: the proxy must handle them for SSRF safety, custom search providers, and image handling
  for (const k of Object.keys(m)) if (!m[k] || (SERVER_ON && search.SERVER_TOOL_NAMES.has(k))) delete m[k]; return m;
}
const nativeWanted = () => nativeMode() !== 'off' && state.native !== 'off';
function nativeToolDef(t, nmap) {
  let d = String(t.description || '').replace(/[ \t]+/g, ' ').trim(); if (d.length > 1500) d = d.slice(0, 1499) + '…';
  const sc = JSON.parse(JSON.stringify(t.input_schema || { type: 'object', properties: {} })); delete sc.$schema;
  return { name: nmap[t.name], description: d || `The ${t.name} tool.`, input_schema: sc };
}
// Server-side tools: Claude Code's WebSearch/WebFetch need an Anthropic server tool this relay lacks, so the proxy runs them.
const SERVER_ON = process.env.SERVER_TOOLS !== '0';
const SYN_TOOLS = [
  { name: 'WebSearch', description: 'Search the web and return result titles, URLs and snippets. Use it for anything current or that you are unsure about. Then read promising pages with WebFetch.', input_schema: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'The search query' }, allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only include results from these domains' }, blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Never include results from these domains' } } } },
  { name: 'WebFetch', description: 'Fetch a web page and return its readable text. The question you want answered goes in prompt.', input_schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'The URL to fetch' }, prompt: { type: 'string', description: 'What to look for on the page' } } } },
  { name: 'fetch_image', description: 'Fetch an image from a URL so you can look at it (screenshots, diagrams, photos).', input_schema: { type: 'object', required: ['url'], properties: { url: { type: 'string', description: 'The image URL (http/https)' } } } },
];
const withServerTools = tools => { const have = new Set(tools.map(t => t.name)); return [...tools, ...SYN_TOOLS.filter(t => !have.has(t.name))]; };

const FORMAT_XML = `To use a tool, write this as plain text (not in a code block):
<tool_call name="Edit">
<param name="file_path">C:\\path\\File.cs</param>
<param name="old_string">
exact existing text
</param>
<param name="new_string">
replacement text
</param>
</tool_call>

Rules:
- Close each parameter with exactly </param> and end the call with exactly </tool_call> (never </parameter> or </invoke>).
- Values are raw: no JSON escaping, no quotes. For multi-line values put them on their own lines between the tags (one leading and one trailing newline are ignored; everything else is kept exactly).
- number/boolean params: plain text (30, true). array/object params: JSON.
`;
const FORMAT_JSON = String.raw`To use a tool, write this as plain text (not in a code block):
<tool_call>
{"name": "Edit", "parameters": {"file_path": "C:\\path\\File.cs", "old_string": "exact existing text", "new_string": "replacement text"}}
</tool_call>

Rules:
- The block holds ONE JSON object with "name" and "parameters". Escape it as valid JSON: \\ for a backslash, \" for a quote, \n for a newline.
- Numbers and booleans are JSON numbers/booleans.
`;
function buildTunnelText(tools) {
  return `<proxy_tools>
You work in the user's project through a local bridge program. The tools listed below run on the user's computer. To run one, call your system_todo_write function with exactly ONE todo item whose "content" is a JSON string like {"name":"Read","parameters":{"file_path":"C:\\\\path\\\\File.cs"}} and whose "status" is "pending". The bridge reads that todo item, runs the tool on the user's machine, and returns the output in the next message as <tool_result>. Use system_todo_write only for this, never read_tabular. Make one call per tool; independent calls may be made together. After calling, stop and wait for the result. Do not describe what you would do: make the call. Keep working until the task is done.

TOOLS (* = required)
${tools.map(toolDoc).join('\n')}
</proxy_tools>`;
}
function buildToolText(tools, fmt = CALL_FORMAT, nativePairs = null) {
  const nat = nativePairs && nativePairs.length ? `\nNATIVE TOOLS (call these through the normal function-calling mechanism, NOT as <tool_call> text; their parameters are exactly those of the original tool): ${nativePairs.map(([c, n]) => `\`${n}\` is your ${c} tool`).join(', ')}.\nIgnore any function named read_tabular or system_todo_write: they are not part of this session.\n` : '';
  const textPart = tools.length ? `The tools below are real and run on the user's machine through a local bridge. They are not in your function list: to call one, write its text block.\n\n${fmt === 'json' ? FORMAT_JSON : FORMAT_XML}- Independent calls may be written together as several <tool_call> blocks. After the last one STOP and wait for results. Never write <tool_result> yourself and never guess an output.\n\nTOOLS (* = required)\n${tools.map(toolDoc).join('\n')}\n` : '';
  return `<proxy_tools>\nThis conversation runs through a local bridge program on the user's computer. The bridge executes tools for you and returns real results in the next message. When a task needs a tool, call it instead of describing what you would do. Keep working until the task is done.\n${nat}${textPart}</proxy_tools>`;
}

// ---------------------------------------------------------------- call parsing
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = { path: 'file_path', filepath: 'file_path', file: 'file_path', cmd: 'command', contents: 'content', text: 'content',
  old: 'old_string', oldstring: 'old_string', new: 'new_string', newstring: 'new_string', replaceall: 'replace_all' };
const trimOne = s => s.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
function parseParams(body) {
  const re = /<param\s+name\s*=\s*(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/param>/g; const out = {}; let m, found = false;
  while ((m = re.exec(body))) { found = true; out[m[1] || m[2]] = trimOne(m[3]); }
  return found ? out : (body.trim() === '' ? {} : null);
}
const OPEN_RE = /<(?:param|parameter)\s+name\s*=\s*(?:"([^"]+)"|'([^']+)')\s*>/g;
function stripClosers(v) {   // remove the model's closing tag(s). A closer is only removed when it has no matching opener inside the value, so real C# '/// <param name="x">..</param>' lines survive
  const t = v.replace(/\s+$/, ''), m = /<\/(?:param|parameter)>$/.exec(t);
  if (!m) return { value: v, closed: false };
  let s = v.slice(0, m.index);
  for (;;) {
    const t2 = s.replace(/\s+$/, ''), m2 = /<\/(param|parameter|invoke|function_calls)>$/.exec(t2); if (!m2) break;
    const opens = (t2.match(new RegExp('<' + m2[1] + '\\b', 'g')) || []).length, closes = (t2.match(new RegExp('</' + m2[1] + '>', 'g')) || []).length;
    if (opens >= closes) break;   // balanced: this closer belongs to the content
    s = t2.slice(0, m2.index);
  }
  return { value: s, closed: true };
}
function parseParamsGuided(body, tool) {   // boundaries = openers named like a real parameter of THIS tool, at a line start / after a closer. Content that merely looks like tags is kept.
  const props = (tool && tool.input_schema && tool.input_schema.properties) || {}, exact = new Set(Object.keys(props).map(norm));
  const find = names => { OPEN_RE.lastIndex = 0; const hits = []; let m;
    while ((m = OPEN_RE.exec(body))) { const nm = m[1] || m[2]; if (!names.has(norm(nm))) continue;
      const before = body.slice(0, m.index).replace(/[ \t]+$/, '');
      if (before === '' || before.endsWith('\n') || /<\/(?:param|parameter)>$/.test(before)) hits.push({ name: nm, start: m.index, vstart: m.index + m[0].length }); }
    return hits; };
  let hits = find(exact); if (!hits.length) hits = find(new Set([...exact, ...Object.keys(ALIASES)]));
  if (!hits.length) return null;
  const params = {}; let lastClosed = true;
  hits.forEach((h, i) => { const end = i + 1 < hits.length ? hits[i + 1].start : body.length; const r = stripClosers(body.slice(h.vstart, end)); params[h.name] = trimOne(r.value); if (i === hits.length - 1) lastClosed = r.closed; });
  return { params, lastClosed };
}
function coerce(v, sc) {
  const t = sc && sc.type; if (v == null || !t) return v;
  if (typeof v === 'string') {
    if (t === 'number' || t === 'integer') { const n = Number(v.trim()); return v.trim() !== '' && Number.isFinite(n) ? n : v; }
    if (t === 'boolean') { const x = v.trim().toLowerCase(); return x === 'true' ? true : x === 'false' ? false : v; }
    if (t === 'array' || t === 'object') { const j = repairJson(v); return j !== null && typeof j === 'object' ? j : v; }
  } else if (t === 'string') return typeof v === 'object' ? JSON.stringify(v) : String(v);
  return v;
}
function normalizeParams(tool, params) {
  const props = (tool.input_schema && tool.input_schema.properties) || {}; const byNorm = {};
  for (const k of Object.keys(props)) byNorm[norm(k)] = k;
  const out = {};
  for (const [k0, v] of Object.entries(params)) {
    let k = k0;
    if (!has(props, k0)) { const a = has(ALIASES, norm(k0)) ? ALIASES[norm(k0)] : null; k = byNorm[norm(k0)] || (a && has(props, a) ? a : k0); }
    out[k] = coerce(v, props[k]);
  }
  if (tool.name === 'Write' && typeof out.content === 'string' && out.content.includes('\n') && !out.content.endsWith('\n')) out.content += '\n';
  return out;
}
const findTool = (name, tools) => tools.find(t => t.name === name) || tools.find(t => t.name.toLowerCase() === String(name).toLowerCase());
function parseCall(tag, body, tools) {
  const na = /\bname\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(tag); let name, params, lastClosed = true;
  if (na) {
    name = na[1] || na[2]; const t0 = findTool(name, tools), g = t0 ? parseParamsGuided(body, t0) : null;
    if (g) { params = g.params; lastClosed = g.lastClosed; } else params = parseParams(body);
    if (!params) { const j = repairJson(body); if (j && typeof j === 'object') params = j.parameters ?? j.params ?? j.input ?? j.arguments ?? j.args ?? j; }
  } else {
    const j = repairJson(body);
    if (j && typeof j === 'object') { name = j.name ?? j.tool; params = j.parameters ?? j.params ?? j.input ?? j.arguments ?? j.args ?? {}; }
    else { const m = /<name>\s*([^<\s]+)\s*<\/name>/.exec(body); if (m) { name = m[1]; params = parseParams(body) || {}; } }
  }
  if (!name) return { error: 'no tool name found' };
  if (!params || typeof params !== 'object') return { error: 'could not read the parameters' };
  const tool = findTool(name, tools);
  if (!tool) return { error: `there is no tool named "${name}"`, unknown: name };
  const p = normalizeParams(tool, params);
  return { tool, params: p, lastClosed, missing: ((tool.input_schema && tool.input_schema.required) || []).filter(k => !has(p, k)) };
}
function extractCalls(text, tools) {
  const OPENERS = ['<tool_call', '<invoke'], CLOSERS = ['</tool_call>', '</invoke>', '</function_calls>'];
  const calls = [], errors = []; let first = -1, pos = 0;
  for (;;) {
    let i = -1, olen = 0; for (const o of OPENERS) { const k = text.indexOf(o, pos); if (k !== -1 && (i === -1 || k < i)) { i = k; olen = o.length; } }
    if (i === -1) break;
    const nx = text[i + olen]; if (nx !== '>' && !/\s/.test(nx || ' ')) { pos = i + olen; continue; }
    const gt = text.indexOf('>', i); if (first === -1) { const w = /<function_calls>\s*$/.exec(text.slice(0, i)); first = w ? w.index : i; }
    if (gt === -1) { errors.push({ reason: 'output was cut off inside the tool call' }); break; }
    let e = -1, clen = 0; for (const c of CLOSERS) { const k = text.indexOf(c, gt); if (k !== -1 && (e === -1 || k < e)) { e = k; clen = c.length; } }
    const body = text.slice(gt + 1, e === -1 ? undefined : e);
    const r = parseCall(text.slice(i, gt + 1), body, tools);
    if (r.error) errors.push({ reason: r.error, unknown: r.unknown });
    else if (e === -1 && (r.missing.length || !r.lastClosed)) errors.push({ reason: 'output was cut off inside the tool call' });
    else calls.push(r);
    if (e === -1) break; pos = e + clen;
  }
  return { before: first === -1 ? text : text.slice(0, first), calls, errors };
}

// ---------------------------------------------------------------- request transform
const proseCall = (name, input) => `[Tool call: ${name}(${Object.entries(input || {}).map(([k, v]) => { const x = typeof v === 'string' ? v : JSON.stringify(v); return x.length <= 100 ? `${k}=${JSON.stringify(x)}` : `${k}=<${x.length} chars>`; }).join(', ')})]`;
const callXml = (name, input, fmt = CALL_FORMAT) => fmt === 'prose' ? proseCall(name, input) : fmt === 'json' ? `<tool_call>\n${JSON.stringify({ name, parameters: input || {} })}\n</tool_call>` : `<tool_call name="${name}">\n${Object.entries(input || {}).map(([k, v]) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v); return s.includes('\n') ? `<param name="${k}">\n${s}\n</param>` : `<param name="${k}">${s}</param>`;
}).join('\n')}\n</tool_call>`;
const stripCC = ({ cache_control, ...rest }) => rest;
// History budget: above TRIM_ABOVE_KB (default 300) the OLD part of the conversation is shrunk, oldest first, in passes, until it is
// under 55% of that limit. Newest messages are never touched in the first pass. TRIM_ABOVE_KB=0 turns it off.
//   pass 1: old tool outputs > 1600 chars -> head+tail (last 10 messages untouched)
//   pass 2: same, but only the last 4 messages are protected
//   pass 3: also old tool-call INPUTS > 1500 chars (big Write/Edit payloads, already on disk) -> a one-line prose note (not call-shaped, so it cannot be imitated)
//   pass 4: tighter thresholds
const TRIM_PASSES = [{ keep: 10, results: 1600 }, { keep: 4, results: 1600 }, { keep: 4, results: 1600, calls: 1500 }, { keep: 4, results: 800, calls: 800 }];
const cutMid = (str, keep) => { const head = Math.floor(keep * 0.6), tail = Math.floor(keep * 0.25); return `${str.slice(0, head)}\n[... ${str.length - head - tail} characters of this old tool output were trimmed by the proxy to save tokens; run the tool again if you need them ...]\n${str.slice(-tail)}`; };
function shrinkResult(b, ps, did) {   // native tool_result block
  if (typeof b.content === 'string') { if (b.content.length <= ps.results) return b; did.results++; return { ...b, content: cutMid(b.content, ps.results) }; }
  if (Array.isArray(b.content)) return { ...b, content: b.content.map(x => x && x.type === 'text' && typeof x.text === 'string' && x.text.length > ps.results ? (did.results++, { ...x, text: cutMid(x.text, ps.results) }) : x) };
  return b;
}
function shrinkUse(b, ps, did) {      // native tool_use block: huge Write/Edit inputs are already on disk
  const inp = b.input || {}; let changed = false; const o = {};
  for (const [k, v] of Object.entries(inp)) { if (typeof v === 'string' && v.length > ps.calls) { o[k] = `[${v.length} characters omitted by the proxy to save tokens]`; changed = true; } else o[k] = v; }
  if (changed) did.calls++; return changed ? { ...b, input: o } : b;
}
function trimOldResults(messages, o = {}) {
  const limit = o.limit !== undefined ? o.limit : envNum('TRIM_ABOVE_KB', 300) * 1024; if (!limit && !o.force) return messages;
  const size = m => Buffer.byteLength(JSON.stringify(m)); let total = size(messages);
  const target = o.target !== undefined ? o.target : limit * 0.55; if ((!o.force && total <= limit) || total <= target) return messages;
  const before = total, passes = o.passes || TRIM_PASSES, did = { results: 0, calls: 0 }; let minKeep = Infinity;
  const RES = /(<tool_result\b[^>]*>)([\s\S]*?)(<\/tool_result>)/g, CALL = /<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/g;
  const shrink = (str, ps) => {
    let t = str.replace(RES, (m, op, body, cl) => { if (body.length <= ps.results) return m; did.results++; const head = Math.floor(ps.results * 0.6), tail = Math.floor(ps.results * 0.25);
      return `${op}${body.slice(0, head)}\n[... ${body.length - head - tail} characters of this old tool output were trimmed by the proxy to save tokens; run the tool again if you need them ...]\n${body.slice(-tail)}${cl}`; });
    if (ps.calls) t = t.replace(CALL, m => { if (m.length <= ps.calls) return m; const nm = (/name["']?\s*[=:]\s*["']?([A-Za-z_]\w*)/.exec(m) || [])[1] || 'tool'; did.calls++;
      return `[earlier ${nm} step: ${m.length} characters of input omitted by the proxy to save tokens; its result follows]`; });
    return t;
  };
  const out = messages.slice();
  for (const ps of passes) {
    minKeep = Math.min(minKeep, ps.keep);
    for (let i = 0; i < out.length - ps.keep && total > target; i++) {
      const m = out[i], was = size(m); let c = m.content;
      if (typeof c === 'string') c = shrink(c, ps); else if (Array.isArray(c)) c = c.map(b => !b ? b : b.type === 'text' && typeof b.text === 'string' ? { ...b, text: shrink(b.text, ps) } : b.type === 'tool_result' ? shrinkResult(b, ps, did) : b.type === 'tool_use' && ps.calls ? shrinkUse(b, ps, did) : b);
      out[i] = { ...m, content: c }; total -= was - size(out[i]);
    }
    if (total <= target) break;
  }
  if (did.results || did.calls) dash.event('trim', `history ${(before / 1024).toFixed(0)} KB -> ${(total / 1024).toFixed(0)} KB (${did.results} tool outputs, ${did.calls} tool-call inputs)`);
  if (did.results || did.calls) log(`history was ${(before / 1024).toFixed(0)} KB: trimmed ${did.results} old tool output(s)${did.calls ? ' and ' + did.calls + ' old tool-call input(s)' : ''} to ${(total / 1024).toFixed(0)} KB (newest ${minKeep} messages untouched)${total > target ? '; still above the ' + Math.round(target / 1024) + ' KB target because the newest messages themselves are large: /compact will fix that' : ''}`);
  return out;
}

// ---------------------------------------------------------------- /compact detection
const COMPACT_RE = /(?:create|write|provide|produce)\s+a\s+(?:detailed\s+)?summary\s+of\s+the\s+(?:conversation|session)|summary of the conversation so far|respond with text only|<analysis>[\s\S]{0,600}<summary>/i;
const textOf = m => !m ? '' : typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n') : '');
function isCompaction(raw) { const ms = (raw && raw.messages) || []; for (let i = ms.length - 1; i >= 0; i--) if (ms[i].role === 'user') return COMPACT_RE.test(textOf(ms[i])); return false; }
const COMPACT_NOTE = 'This request asks for a written summary of the conversation. Answer with plain text only, in the sections the user asks for. Do not call any tool and do not write <tool_call> blocks.';
const COMPACT_PASSES = [{ keep: 6, results: 1200 }, { keep: 4, results: 1200, calls: 1200 }, { keep: 2, results: 600, calls: 600 }];

const droppedTypes = new Set();
const resultBlocks = c => {   // content of a native tool_result: text + images kept, nothing else
  if (typeof c === 'string') return c || '(no output)';
  if (!Array.isArray(c)) return c == null ? '(no output)' : JSON.stringify(c);
  const out = c.map(x => (x && x.type === 'text') ? { type: 'text', text: x.text || '' } : (x && (x.type === 'image' || x.type === 'document')) ? stripCC(x) : (x != null ? { type: 'text', text: JSON.stringify(x) } : null)).filter(Boolean);
  return out.length ? out : '(no output)';
};
function repairPairs(msgs) {   // the API rejects a tool_use without a result and a result without a tool_use: make every pair whole
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]; if (!Array.isArray(m.content)) { out.push(m); continue; }
    if (m.role === 'assistant') {
      const ids = m.content.filter(b => b.type === 'tool_use').map(b => b.id); out.push(m);
      if (ids.length) { const nx = msgs[i + 1]; if (nx && nx.role === 'user') { const have = new Set((Array.isArray(nx.content) ? nx.content : []).filter(b => b.type === 'tool_result').map(b => b.tool_use_id));
        const miss = ids.filter(id => !have.has(id)); if (miss.length) { const c = Array.isArray(nx.content) ? nx.content : [{ type: 'text', text: String(nx.content) }]; msgs[i + 1] = { ...nx, content: [...miss.map(id => ({ type: 'tool_result', tool_use_id: id, content: '(no result was recorded for this call)', is_error: true })), ...c] }; } } }
    } else {
      const prev = out[out.length - 1], ok = new Set(prev && prev.role === 'assistant' && Array.isArray(prev.content) ? prev.content.filter(b => b.type === 'tool_use').map(b => b.id) : []);
      const c = m.content.filter(b => b.type !== 'tool_result' || ok.has(b.tool_use_id)); out.push(c.length ? { ...m, content: c } : { ...m, content: [{ type: 'text', text: '(continued)' }] });
    }
  }
  return out;
}
function flattenMessages(messages, fmt = CALL_FORMAT, nat = null) {      // history becomes text the model can follow; native tools keep structured blocks when nat is given
  const idName = new Map(), fake = new Set(), out = [], nativeIds = new Set(), map = (nat && nat.map) || {};
  if (nat) for (const m of messages) if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_use' && map[b.name]) nativeIds.add(b.id);
  let loopStart = 0;   // current tool loop = everything after the last real user message; only there are thinking blocks kept (native mode)
  if (nat && nat.keepThinking) for (let i = messages.length - 1; i >= 0; i--) { const m = messages[i]; if (m.role === 'user' && !(Array.isArray(m.content) && m.content.length && m.content.every(b => b && b.type === 'tool_result'))) { loopStart = i; break; } }
  messages.forEach((m, mi) => {
    const src = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (Array.isArray(m.content) ? m.content : []);
    const parts = []; let cc = null; const add = t => { if (t && t.trim()) parts.push({ type: 'text', text: t }); };
    const hasNat = m.role === 'assistant' && src.some(b => b && b.type === 'tool_use' && map[b.name]);
    for (const b of src) {
      if (!b || typeof b !== 'object') continue; if (b.cache_control) cc = b.cache_control;
      if (b.type === 'text') add(b.text);
      else if (b.type === 'tool_use') { if (FAKE_TOOLS.has(b.name)) fake.add(b.id); else if (nat && map[b.name]) parts.push({ type: 'tool_use', id: b.id, name: map[b.name], input: b.input || {} }); else { idName.set(b.id, b.name); add(callXml(b.name, b.input, fmt)); } }
      else if (b.type === 'tool_result') {
        if (fake.has(b.tool_use_id)) continue;
        if (nativeIds.has(b.tool_use_id)) { parts.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: resultBlocks(b.content), ...(b.is_error ? { is_error: true } : {}) }); continue; }
        let txt = ''; const media = [];
        if (typeof b.content === 'string') txt = b.content;
        else if (Array.isArray(b.content)) for (const x of b.content) {
          if (x && x.type === 'text') txt += (txt ? '\n' : '') + x.text;
          else if (x && (x.type === 'image' || x.type === 'document')) media.push(stripCC(x));
          else if (x != null) txt += (txt ? '\n' : '') + JSON.stringify(x);
        } else if (b.content != null) txt = JSON.stringify(b.content);
        const nm = idName.get(b.tool_use_id);
        add(`<tool_result${nm ? ` tool="${nm}"` : ''} id="${String(b.tool_use_id || '').slice(-6)}"${b.is_error ? ' error="true"' : ''}>\n${txt || '(no output)'}\n</tool_result>`);
        parts.push(...media);
      } else if (b.type === 'image' || b.type === 'document') parts.push(stripCC(b));
      else if (b.type === 'thinking' || b.type === 'redacted_thinking') { if (nat && nat.keepThinking && hasNat && mi >= loopStart) parts.push({ ...b }); }
      else droppedTypes.add(b.type);
    }
    if (!parts.length) return;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.parts.push(...parts); else out.push({ role: m.role, parts, cc });
    if (cc) out[out.length - 1].cc = cc;
  });
  const rank = (role, p) => (role === 'user' ? (p.type === 'tool_result' ? 0 : 1) : (p.type === 'thinking' || p.type === 'redacted_thinking' ? 0 : p.type === 'tool_use' ? 2 : 1));
  return out.map(({ role, parts, cc }) => {
    const sorted = parts.map((p, i) => [p, i]).sort((a, b) => rank(role, a[0]) - rank(role, b[0]) || a[1] - b[1]).map(x => x[0]);
    const merged = []; for (const p of sorted) { const l = merged[merged.length - 1]; if (p.type === 'text' && l && l.type === 'text') l.text += '\n\n' + p.text; else merged.push({ ...p }); }
    if (cc) merged[merged.length - 1].cache_control = cc;
    return { role, content: merged.length === 1 && merged[0].type === 'text' && !cc ? merged[0].text : merged };
  });
}
function withFewShot(messages, tools, fmt = CALL_FORMAT) {   // one tiny worked example so the model sees the format succeed before its first real call
  if (!FEWSHOT || !tools.some(t => t.name === 'Read') || !messages.length || messages[0].role !== 'user') return messages;
  if (messages.some(m => { const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content); return c.includes('<tool_call') || c.includes('<invoke'); })) return messages;   // history already shows real calls
  return [{ role: 'user', content: 'Quick bridge check: use your Read tool on README.md.' },
    { role: 'assistant', content: callXml('Read', { file_path: 'README.md' }, fmt) },
    { role: 'user', content: '<tool_result tool="Read" id="check01">\n# README\nbridge check ok\n</tool_result>' },
    { role: 'assistant', content: 'The Read tool works through the bridge. Ready for your task.' }, ...messages];
}
const UP_MODEL = process.env.UPSTREAM_MODEL || '', modelNoted = new Set();
function transform(raw, transport = 'text', fmt = CALL_FORMAT, extra = '', o = {}) {
  const p = JSON.parse(JSON.stringify(raw)); const compact = isCompaction(raw); let tools = compact ? [] : selectTools(p.tools, p.tool_choice); const total = (p.tools || []).length; droppedTypes.clear();
  const agentLike = tools.some(t => CORE_TOOLS.has(t.name)); if (agentLike && SERVER_ON) tools = withServerTools(tools);
  const nmap = nativeMap(), natOn = !!o.nat && !compact && transport === 'text' && agentLike && tools.some(t => nmap[t.name]);
  const nativeTools = natOn ? tools.filter(t => nmap[t.name]) : [], textTools = natOn ? tools.filter(t => !nmap[t.name]) : tools;
  const natRev = natOn ? Object.fromEntries(nativeTools.map(t => [nmap[t.name], t.name])) : null;
  const choice = p.tool_choice ? JSON.stringify(p.tool_choice) : 'none', rawNames = (p.tools || []).map(t => t.name);
  delete p.tools; delete p.tool_choice; delete p.context_management;
  if (natOn) p.tools = nativeTools.map(t => nativeToolDef(t, nmap));
  if (o.model) p.model = o.model;
  if (UP_MODEL && p.model && p.model !== UP_MODEL) { if (!modelNoted.has(p.model)) { modelNoted.add(p.model); log(`model ${p.model} is not offered by the provider: using ${UP_MODEL} (UPSTREAM_MODEL)`); } p.model = UP_MODEL; }
  if (tools.length) {
    const inj = transport === 'tunnel' ? buildTunnelText(tools) : buildToolText(textTools, fmt, natOn ? nativeTools.map(t => [t.name, nmap[t.name]]) : null);
    let tail = transport === 'tunnel' ? 'Reminder: run tools by calling system_todo_write as described in <proxy_tools> at the top of this prompt.' : natOn ? 'Reminder: read, write, edit and bash are native functions; every other tool uses the <tool_call> text block described in <proxy_tools> at the top of this prompt.' : 'Reminder: tools run through the <tool_call> text bridge described in <proxy_tools> at the top of this prompt.';
    if (extra) tail += ' ' + extra;
    if (Array.isArray(p.system)) { p.system.unshift({ type: 'text', text: inj }); p.system.push({ type: 'text', text: tail }); }
    else p.system = inj + '\n\n' + (p.system || '') + '\n\n' + tail;
    log(`[${natOn ? 'native+text' : transport}] tools ${tools.length}/${total} kept: ${tools.map(t => t.name).join(', ')}  (tool text ≈ ${estTokens(inj)} tokens)`);
  }
  if (compact) { const cn = COMPACT_NOTE + (extra ? ' ' + extra : ''); if (Array.isArray(p.system)) p.system.unshift({ type: 'text', text: cn }); else p.system = cn + '\n\n' + (p.system || ''); }
  const flat = flattenMessages(p.messages || [], compact ? 'prose' : fmt, natOn ? { map: nmap, keepThinking: !!p.thinking } : null), flatKB = Buffer.byteLength(JSON.stringify(flat)) / 1024;
  p.messages = compact ? trimOldResults(flat, { force: true, target: (o.compactTarget || envNum('COMPACT_TARGET_KB', 200)) * 1024, passes: COMPACT_PASSES }) : trimOldResults(flat);
  if (compact) log(`[compact] summary request detected: tools OFF (the model must answer in plain text), history ${flatKB.toFixed(0)} KB -> ${(Buffer.byteLength(JSON.stringify(p.messages)) / 1024).toFixed(0)} KB, streaming upstream (a long summary can take minutes)`);
  if (droppedTypes.size) log(`WARNING: message blocks of unknown type dropped: ${[...droppedTypes].join(', ')}`);
  if (!compact && !tools.some(t => CORE_TOOLS.has(t.name)) ) { const last = [...p.messages].reverse().find(m => m.role === 'user'); const lt = last ? (typeof last.content === 'string' ? last.content : last.content.filter(b => b.type === 'text').map(b => b.text).join(' ')) : '';
    log(`side-request (not the coding agent): tools=[${rawNames.join(',')}] tool_choice=${choice} emulated=[${tools.map(t => t.name).join(',')}] max_tokens=${raw.max_tokens} msgs=${p.messages.length} last-user=\"${lt.replace(/\s+/g, ' ').slice(0, 110)}\"`);
    const sysText = Array.isArray(p.system) ? p.system.map(b => b.text || '').join(' ') : String(p.system || '');
    log(`side-request detail: keys=[${Object.keys(raw).join(',')}] stop_sequences=${JSON.stringify(raw.stop_sequences || [])} thinking=${raw.thinking ? JSON.stringify(raw.thinking) : 'none'} system-tail="${sysText.replace(/\s+/g, ' ').slice(-200)}" user-tail="${lt.replace(/\s+/g, ' ').slice(-200)}"`); }
  if (natOn) p.messages = repairPairs(p.messages);
  if (tools.length && transport === 'text' && !natOn) p.messages = withFewShot(p.messages, tools, fmt);
  if (!KEEP_CACHE) { p.system = noCache(p.system); p.messages = noCache(p.messages); if (p.tools) p.tools = noCache(p.tools); }
  p.stream = process.env.UPSTREAM_STREAM === '1' || state.stream || compact;     // default: provider is called without streaming. UPSTREAM_STREAM=1: stream it, buffer it here, hand Claude Code the same complete answer
  return { payload: p, tools, compact, native: natOn, natRev, side: !compact && !agentLike };
}

// ---------------------------------------------------------------- upstream call (headers exactly as before)
function upstreamHeaders(req, len) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (lk.startsWith('anthropic-') || ['x-api-key', 'authorization', 'content-type', 'accept'].includes(lk)) h[lk] = v;
  }
  if (process.env.UPSTREAM_UA) h['user-agent'] = process.env.UPSTREAM_UA;
  if (!h['x-api-key'] && !h['authorization']) h['x-api-key'] = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
  if (!h['anthropic-version']) h['anthropic-version'] = '2023-06-01';
  h['content-type'] = 'application/json'; h['content-length'] = len; h['host'] = TARGET.host;
  return h;
}
function assembleSse(text) {   // provider SSE -> one Messages-API JSON object (text, thinking+signature, tool_use, usage, stop_reason)
  const m = { content: [], usage: {} }; let started = false, err = null;
  for (const blk of String(text).split(/\r?\n\r?\n/)) {
    const dl = blk.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join(''); if (!dl || dl === '[DONE]') continue;
    let d; try { d = JSON.parse(dl); } catch { continue; }
    if (d.type === 'message_start' && d.message) { started = true; m.id = d.message.id; m.model = d.message.model; Object.assign(m.usage, d.message.usage || {}); }
    else if (d.type === 'content_block_start') m.content[d.index] = { ...d.content_block, _j: '' };
    else if (d.type === 'content_block_delta') { const b = m.content[d.index]; if (!b) continue; const x = d.delta || {};
      if (x.type === 'text_delta') b.text = (b.text || '') + x.text; else if (x.type === 'thinking_delta') b.thinking = (b.thinking || '') + x.thinking;
      else if (x.type === 'signature_delta') b.signature = (b.signature || '') + x.signature; else if (x.type === 'input_json_delta') b._j += x.partial_json; }
    else if (d.type === 'message_delta') { if (d.delta && d.delta.stop_reason) m.stop_reason = d.delta.stop_reason; Object.assign(m.usage, d.usage || {}); }
    else if (d.type === 'error') err = d.error || d;
  }
  if (!started) return { error: err || { message: 'provider stream had no message_start' } };
  m.content = m.content.filter(Boolean).map(({ _j, ...b }) => b.type === 'tool_use' ? { ...b, input: (() => { try { return JSON.parse(_j || '{}'); } catch { return {}; } })() } : b);
  return { message: m, error: err };
}
function callUpstreamOnce(path, headers, body, ctl) {
  return new Promise((resolve, reject) => {
    const r = transport.request({ hostname: TARGET.hostname, port: TARGET.port || (TARGET.protocol === 'http:' ? 80 : 443), path, method: 'POST', headers }, up => {
      let t = ''; up.setEncoding('utf8'); up.on('data', c => { t += c; }); up.on('end', () => {
        if (up.statusCode === 200 && /event-stream/.test(up.headers['content-type'] || '')) { const a = assembleSse(t); if (a.message) return resolve({ status: 200, headers: { ...up.headers, 'content-type': 'application/json' }, text: JSON.stringify(a.message) }); return resolve({ status: 502, headers: up.headers, text: JSON.stringify({ error: a.error }) }); }
        resolve({ status: up.statusCode, headers: up.headers, text: t }); });
      up.on('error', reject);
    });
    const toMs = envNum('UPSTREAM_TIMEOUT_S', 180) * 1000; ctl.req = r; r.setTimeout(toMs, () => { const e = new Error(`provider sent nothing for ${toMs / 1000}s`); e.timeout = true; r.destroy(e); }); r.on('error', reject); r.write(body); r.end();
  });
}
async function callUpstream(path, headers, body, ctl) {
  const max = ctl.maxRetries !== undefined ? ctl.maxRetries : envNum('UP_RETRIES', 6), budget = envNum('UP_BUDGET_S', 60) * 1000, t0 = Date.now(); let retries = 0;
  for (let i = 0; ; i++) {
    const wait = () => Math.min(15000, 1000 * 2 ** i) * (0.75 + Math.random() * 0.5);
    try {
      const r = await callUpstreamOnce(path, headers, body, ctl);
      if ([429, 502, 503, 529].includes(r.status) && i < max && !ctl.closed && Date.now() - t0 + 1000 < budget) { const w = wait(); retries++; dash.event('retry', `provider ${r.status}: retry ${i + 1}/${max} in ${(w / 1000).toFixed(1)}s`); log(`provider ${r.status} (${r.text.slice(0, 80).replace(/\s+/g, ' ')}) - retry ${i + 1}/${max} in ${(w / 1000).toFixed(1)}s`); await sleep(w); continue; }
      r.retries = retries; return r;
    } catch (e) { if (!e.timeout && i < max && !ctl.closed && Date.now() - t0 + 1000 < budget) { const w = wait(); retries++; log(`network error ${e.message} - retry ${i + 1}/${max} in ${(w / 1000).toFixed(1)}s`); await sleep(w); continue; } throw e; }
  }
}

// ---------------------------------------------------------------- response -> Claude Code blocks
function tunnelCalls(content, tools) {      // real tool calls carried inside the provider's own system_todo_write function
  const calls = [], errors = [], seen = new Set();
  for (const b of content) {
    if (b.type !== 'tool_use' || b.name !== 'system_todo_write') continue;
    const todos = b.input && Array.isArray(b.input.todos) ? b.input.todos : [];
    for (const td of todos) {
      const raw = typeof td === 'string' ? td : String((td && (td.content ?? td.text ?? td.task)) ?? '');
      if (seen.has(raw)) continue; seen.add(raw);       // todo tools often resend the whole list: never run an item twice
      const j = raw.trim().startsWith('{') || raw.trim().startsWith('`') ? repairJson(raw) : null;
      const name = j && typeof j === 'object' ? (j.name ?? j.tool) : null;
      if (!name) continue;                               // an ordinary todo item, not a tool call
      const tool = findTool(name, tools);
      if (!tool) { errors.push({ reason: `there is no tool named "${name}"`, unknown: name }); continue; }
      const params = normalizeParams(tool, j.parameters ?? j.params ?? j.input ?? j.arguments ?? j.args ?? {});
      calls.push({ tool, params, missing: ((tool.input_schema && tool.input_schema.required) || []).filter(k => !has(params, k)) });
    }
  }
  return { calls, errors };
}
function analyze(data, tools, natRev = null) {
  const content = Array.isArray(data.content) ? data.content : [];
  const text = content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  const isNat = b => b.type === 'tool_use' && natRev && has(natRev, b.name);
  const providerCalls = content.filter(b => b.type === 'tool_use' && !isNat(b));          // the gateway's own functions
  const nativeCalls = [];
  for (const b of content) if (isNat(b)) { const tool = tools.find(t => t.name === natRev[b.name]); if (tool) { const params = b.input && typeof b.input === 'object' ? b.input : {}; nativeCalls.push({ tool, params, native: true, missing: ((tool.input_schema && tool.input_schema.required) || []).filter(k => !has(params, k)) }); } }
  const x = extractCalls(text, tools), tn = tunnelCalls(content, tools);
  const calls = [...nativeCalls, ...x.calls, ...tn.calls], errors = [...x.errors, ...tn.errors];
  const refusal = !calls.length && !errors.length && (FAKE_RE.test(text) || providerCalls.some(b => FAKE_TOOLS.has(b.name)) || REFUSAL_RE.test(text));
  return { thinking: content.filter(b => b.type === 'thinking' || b.type === 'redacted_thinking'), text, before: x.before, textCalls: x.calls.length, nativeCalls: nativeCalls.length, tunnelCalls: tn.calls.length, calls, errors, refusal };
}
function retryNote(a, tools, transport = 'text') {
  if (a.errors.length) {
    const e = a.errors[0];
    return transport === 'tunnel' ? `That tool call failed (${e.reason}). Available tools: ${tools.map(t => t.name).join(', ')}. Please make the system_todo_write call again with valid JSON.`
      : e.unknown ? `That tool call failed: ${e.reason}. Available tools: ${tools.map(t => t.name).join(', ')}. Please send the call again as a <tool_call name="..."> block.`
      : `That tool call could not be run (${e.reason}). Please send only the corrected <tool_call name="..."> block with <param name="..."> tags.`;
  }
  return 'The tools listed in the system prompt are available: they run through <tool_call> text blocks that the local bridge executes (they are not in your function list, which is expected). Please make the call now as a <tool_call name="..."> block.';
}
function buildBlocks(data, a) {
  const blocks = [...a.thinking];
  let lead = a.textCalls ? a.before : (a.nativeCalls ? a.text : (a.calls.length ? '' : a.text));
  if (!a.calls.length && a.errors.length) lead += `\n\n⚠ The tool call could not be run (${a.errors[0].reason}).`;
  if (a.calls.length && a.errors.length) lead += `\n\n⚠ ${a.errors.length} other tool call(s) were malformed and skipped; re-issue them.`;
  if (/<tool_result/i.test(lead)) { log('removed a tool result the model wrote itself (it must never invent outputs)'); lead = lead.replace(/<tool_result[\s\S]*?(?:<\/tool_result>|$)/gi, ''); }
  if (lead.trim()) blocks.push({ type: 'text', text: lead.trim() });
  for (const c of a.calls) blocks.push({ type: 'tool_use', id: `toolu_${crypto.randomBytes(12).toString('hex')}`, name: c.tool.name, input: c.params });
  if (!blocks.length) { blocks.push({ type: 'text', text: '(the provider returned an empty reply)' }); log('empty reply from provider:', JSON.stringify(data).slice(0, 300)); }
  if (a.calls.length && a.text.slice(a.text.lastIndexOf('</tool_call>') + 12).trim()) dbg('dropped text after the last tool call (model tried to continue without results)');
  return blocks;
}
function sendResponse(res, wantStream, data, blocks, hasCall, reqBytes) {
  const usage = data.usage || {}; const stop = hasCall ? 'tool_use' : (data.stop_reason && data.stop_reason !== 'tool_use' ? data.stop_reason : 'end_turn');
  const outTok = usage.output_tokens || estTokens(JSON.stringify(blocks)); const ru = reportUsage(data, outTok, reqBytes); delete ru.estimated;
  if (!wantStream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: data.id || 'msg_proxy', type: 'message', role: 'assistant', model: data.model, content: blocks, stop_reason: stop, stop_sequence: null, usage: ru }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write(createSse('message_start', { type: 'message_start', message: { id: data.id || 'msg_proxy', type: 'message', role: 'assistant', content: [], model: data.model, stop_reason: null, stop_sequence: null, usage: { ...ru, output_tokens: 1 } } }));
  blocks.forEach((b, i) => {
    if (b.type === 'text') { res.write(createSse('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })); res.write(createSse('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } })); }
    else if (b.type === 'thinking') { res.write(createSse('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '' } })); res.write(createSse('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: b.thinking || '' } })); if (b.signature) res.write(createSse('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: b.signature } })); }
    else if (b.type === 'redacted_thinking') res.write(createSse('content_block_start', { type: 'content_block_start', index: i, content_block: b }));
    else if (b.type === 'tool_use') { res.write(createSse('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })); res.write(createSse('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })); }
    res.write(createSse('content_block_stop', { type: 'content_block_stop', index: i }));
  });
  res.write(createSse('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outTok } }));
  res.write(createSse('message_stop', { type: 'message_stop' })); res.end();
}
const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']);
const CLAIM_RE = /\b(?:i['’]ve|i have|i just|i['’]ve now|has been|have been|is now|are now)\s+(?:\w+\s+){0,2}(?:edited|updated|modified|written|rewritten|created|added|inserted|replaced|removed|deleted|patched|applied|saved|fixed)\b/i;
function loopUsedWriteTool(messages) {   // any write-capable tool_use since the last real user message?
  const ms = messages || []; let start = 0;
  for (let k = ms.length - 1; k >= 0; k--) { const m = ms[k]; if (m.role === 'user' && !(Array.isArray(m.content) && m.content.length && m.content.every(b => b && b.type === 'tool_result'))) { start = k; break; } }
  return ms.slice(start).some(m => Array.isArray(m.content) && m.content.some(b => b && b.type === 'tool_use' && WRITE_TOOLS.has(b.name)));
}
function looksUnfinished(text) {   // true when the reply reads like "I'll do X next" (or is empty) instead of a finished answer
  const t = String(text || '').replace(/\s+/g, ' ').trim(); if (!t) return true;
  if (/\b(?:let me know|feel free|want me to|would you like|shall i|should i|do you want|your call)\b/i.test(t.slice(-240))) return false;   // asking/offering = a deliberate stop
  if (/:\s*$/.test(t)) return true;
  const last = t.split(/(?<=[.!?])\s+/).pop();
  return last.length < 500 && /\b(?:let me|now i['’]ll|i['’]ll now|i will now|next,? i['’]ll|i['’]m going to|let['’]s)\b/i.test(last);
}
function capture(payload, messages, data) {   // PROXY_CAPTURE=1: write the side-request and the provider's reply to ./captures (contains your CLAUDE.md/transcript: review before sharing)
  try { const fs = require('node:fs'), path = require('node:path'); const dir = process.env.CAPTURE_DIR || path.join(__dirname, 'captures'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `side-${Date.now()}.json`); fs.writeFileSync(f, JSON.stringify({ request: { ...payload, messages }, response: data }, null, 2)); log(`captured side-request -> ${f}`); } catch (e) { log('capture failed:', e.message); }
}
const summarizeCall = c => Object.entries(c.params || {}).map(([k, v]) => { const x = typeof v === 'string' ? v : JSON.stringify(v); return `${k}=${x.length > 60 ? x.slice(0, 57) + '…' : x}`; }).join(' ').slice(0, 160);
function makeAsk(req, model) {   // one plain upstream call used by the auto-compactor (no tools, no streaming)
  return async (system, user, maxTokens) => {
    const text = JSON.stringify({ model, max_tokens: maxTokens, stream: false, system, messages: [{ role: 'user', content: user }] });
    const id = dash.begin({ kind: 'summary', model, reqKB: Buffer.byteLength(text) / 1024 }), t1 = Date.now();
    const hb = setInterval(() => log(`[auto-compact] still summarizing: ${Math.round((Date.now() - t1) / 1000)}s (${(Buffer.byteLength(text) / 1024).toFixed(0)} KB)`), envNum('HEARTBEAT_S', 20) * 1000);
    try {
      const up = await callUpstream('/v1/messages', upstreamHeaders(req, Buffer.byteLength(text)), text, { closed: false, req: null, maxRetries: 3 });
      if (up.status !== 200) throw new Error(`provider ${up.status}`);
      const d = JSON.parse(up.text), u = usageTotals(d);
      dash.end(id, { ms: Date.now() - t1, inTok: u.total, outTok: u.out, cacheRead: u.read, cacheWrite: u.write, httpStatus: 200 });
      return (d.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    } catch (e) { dash.end(id, { status: 'error', ms: Date.now() - t1, httpStatus: 0 }); throw e; } finally { clearInterval(hb); }
  };
}
async function handleMessages(req, res, rawBody) {
  let body; try { body = JSON.parse(rawBody); } catch { return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad JSON' } }); }
  const wantStream = body.stream !== false;
  const kind0 = isCompaction(body) ? 'compact' : (selectTools(body.tools, body.tool_choice).some(t => CORE_TOOLS.has(t.name)) ? 'agent' : 'side');
  const ctl = { closed: false, req: null, maxRetries: undefined }, t0 = Date.now();
  const recId = dash.begin({ kind: kind0, model: body.model, reqKB: 0 });
  const acc = { inTok: 0, outTok: 0, read: 0, write: 0 }; let extraAsks = 0, retriesTotal = 0, finalized = false, serverIter = 0, compactTries = 0, serverNames = new Set();
  const finish = patch => { if (finalized) return; finalized = true; dash.end(recId, { ms: Date.now() - t0, inTok: acc.inTok, outTok: acc.outTok, cacheRead: acc.read, cacheWrite: acc.write, extra: extraAsks, retries: retriesTotal, ...patch }); };
  res.on('close', () => { if (!res.writableEnded) { ctl.closed = true; if (ctl.req) ctl.req.destroy(); log('client disconnected - provider request cancelled'); finish({ status: 'cancelled' }); } });

  // ---- proxy-side auto-compaction: the old part of a long history is replaced (upstream only) by a cached summary
  let eff = body;
  if (kind0 === 'agent' && Array.isArray(body.messages)) {
    try { const ac = await compactor.apply(body.messages, makeAsk(req, UP_MODEL || body.model)); if (ac) { eff = { ...body, messages: ac.messages }; dash.note(recId, ac.info.summarized ? `auto-compact: ${ac.info.fromKB.toFixed(0)} KB -> ${ac.info.toKB.toFixed(0)} KB (new notes, ${(ac.info.ms / 1000).toFixed(1)}s)` : `auto-compact: reused cached notes, ${ac.info.fromKB.toFixed(0)} KB -> ${ac.info.toKB.toFixed(0)} KB`); } }
    catch (e) { log('[auto-compact] error:', e.message); }
  }

  let transport = opts.TRANSPORT === 'tunnel' || (opts.TRANSPORT === 'auto' && state.tunnel) ? 'tunnel' : 'text';
  let fmt = state.fmt || CALL_FORMAT, natNow = kind0 === 'agent' && nativeWanted(), compactTarget = 0, modelOverride = '', reqStream = false;
  const mainModel = () => UP_MODEL || state.mainModel || process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
  const retransform = (t, f, extra) => { const r = transform(eff, t, f, extra, { nat: natNow && t === 'text', compactTarget, model: modelOverride || (state.badModels.has(eff.model) ? mainModel() : '') }); if (reqStream) r.payload.stream = true; return r; };
  let { payload, tools, side, compact, native, natRev } = retransform(transport, fmt);
  reqStream = !!compact;
  const extraMsgs = []; let messages = payload.messages;
  const rebase = () => { messages = payload.messages.concat(extraMsgs); };
  const apply = r => { ({ payload, tools, native, natRev } = r); rebase(); };
  if (kind0 === 'side' && payload.model !== mainModel() && state.mainModel) ctl.maxRetries = 1;     // an unknown model fails fast: it is retried under the main model, not hammered
  let fmtRetries = 0, fwRetries = 0, contRetries = 0, hallRetries = 0;
  const lastM = (body.messages || [])[(body.messages || []).length - 1];
  const midLoop = !!(lastM && lastM.role === 'user' && Array.isArray(lastM.content) && lastM.content.some(b => b && b.type === 'tool_result'));
  try {
    for (;;) {
      const upBody = JSON.stringify({ ...payload, messages });
      const kb = Buffer.byteLength(upBody) / 1024, t1 = Date.now(); dash.patch(recId, { reqKB: kb, native, model: payload.model });
      log(`Sending ${native ? 'native+text' : transport}-emulated request to ${TARGET.hostname} (stream=${payload.stream}, ${kb.toFixed(1)} KB${fmtRetries ? ', retry ' + fmtRetries : ''})`);
      const hb = setInterval(() => log(compact ? `[compact] still summarizing: ${Math.round((Date.now() - t1) / 1000)}s (${kb.toFixed(0)} KB request, streaming; long summaries take a few minutes)` : `still waiting for the provider: ${Math.round((Date.now() - t1) / 1000)}s (${kb.toFixed(0)} KB request${kb > 400 ? ' - a prompt this big is slow' : ''})`), envNum('HEARTBEAT_S', 20) * 1000);
      let up;
      try { up = await callUpstream(req.url, upstreamHeaders(req, Buffer.byteLength(upBody)), upBody, ctl); }
      catch (e) {
        if (e.timeout && !payload.stream && !ctl.closed) { reqStream = true; if (process.env.STREAM_STICKY === '1') state.stream = true; log(`${e.message}: switching to streaming for this request (bytes keep flowing, so the connection is not cut). No blind retry of the same request.`); dash.event('fallback', 'provider silent: this request re-sent once in streaming mode'); apply(retransform(transport, fmt)); continue; }
        throw e;
      } finally { clearInterval(hb); }
      const secs = ((Date.now() - t1) / 1000).toFixed(1); retriesTotal += up.retries || 0;
      if (up.status !== 200) {
        log(`Response Code: ${up.status} (${secs}s) server=${up.headers.server || '?'} body=${up.text.slice(0, 200).replace(/\s+/g, ' ') || '(empty)'}`);
        dash.event('http', `${up.status} from provider after ${secs}s ${up.text.slice(0, 120).replace(/\s+/g, ' ')}`);
        if (native && [400, 422].includes(up.status) && !ctl.closed) {      // the relay rejected the native tool request: fall back to the text bridge
          state.nativeFails++; if (state.native !== 'on' || state.nativeFails >= 3) state.native = 'off';
          natNow = false; log(`native tool request rejected (${up.status}); using the text bridge${state.native === 'off' ? ' from now on' : ' for this request'}`); dash.event('fallback', `native tools rejected (${up.status}) -> text bridge${state.native === 'off' ? ' (permanently)' : ''}`);
          extraAsks++; apply(retransform(transport, fmt)); continue;
        }
        if ([400, 404, 503].includes(up.status) && /model|channel/i.test(up.text) && !modelOverride && payload.model !== mainModel() && !ctl.closed) {   // e.g. Claude Code's small "haiku" side requests: the relay only has the main model
          state.badModels.add(eff.model); modelOverride = mainModel(); ctl.maxRetries = undefined; log(`model ${payload.model} unavailable at the provider: retrying with ${modelOverride} (and using it for that model from now on)`); dash.event('fallback', `${payload.model} unavailable -> ${modelOverride}`);
          extraAsks++; apply(retransform(transport, fmt)); continue;
        }
        if ((up.status === 524 || up.status === 504) && !payload.stream && !ctl.closed) { reqStream = true; if (process.env.STREAM_STICKY === '1') state.stream = true; log(`provider timed out (${up.status}) after ${secs}s: this request is re-sent ONCE in streaming mode (later requests go back to normal calls)`); apply(retransform(transport, fmt)); continue; }
        // empty-body Cloudflare 403 = firewall verdict, no model involved. One delayed identical resend covers a rate-based trip; a content-based block repeats and is reported.
        if (up.status === 403 && !up.text && /cloudflare/i.test(up.headers.server || '') && fwRetries < 1 && !ctl.closed) { fwRetries++; stats.extra.firewall++; extraAsks++; log('firewall 403 - waiting 4s, one resend of the same request'); await sleep(4000); continue; }
        finish({ status: 'error', httpStatus: up.status }); res.writeHead(up.status, { 'content-type': up.headers['content-type'] || 'application/json' }); return res.end(up.text);
      }
      let data; try { data = JSON.parse(up.text); } catch { log('provider sent unreadable JSON:', up.text.slice(0, 200)); finish({ status: 'error', httpStatus: 502 }); return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: 'provider sent unreadable JSON' } }); }
      const ut = usageTotals(data), ru = reportUsage(data, ut.out, Buffer.byteLength(upBody)); acc.inTok += ut.total || ru.input_tokens; acc.outTok += ut.out; acc.read += ut.read; acc.write += ut.write;
      stats.calls++; stats.inTok += ut.total || ru.input_tokens; stats.outTok += ut.out; { const ex = stats.extra, extras = ex.format + ex.continue + ex.claim + ex.firewall;
        log(`usage: input=${ut.total.toLocaleString()} (cache write ${ut.write.toLocaleString()} / read ${ut.read.toLocaleString()}) output=${ut.out.toLocaleString()}${ru.estimated ? ` (provider reported too little: telling Claude Code ~${ru.input_tokens} input tokens)` : ''} | session: ${stats.calls} calls, ~${Math.round(stats.inTok / 1000)}k input tokens, ${extras} extra asks (format ${ex.format}, continue ${ex.continue}, claim ${ex.claim}, firewall ${ex.firewall})`); }
      if (kb > 500) log('WARNING: this request is over 500 KB. Auto-compaction should keep it smaller: check AUTO_COMPACT_KB / the dashboard events.');
      if (side && process.env.PROXY_CAPTURE === '1') capture(payload, messages, data);

      if (compact) {   // Claude Code's /compact wants TEXT. Whatever tool-call text the model still wrote is removed; nothing is executed.
        const content = Array.isArray(data.content) ? data.content : [], rawText = content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
        const clean = rawText.replace(/<tool_call\b[\s\S]*?(?:<\/tool_call>|$)/g, '').replace(/<invoke\b[\s\S]*?(?:<\/invoke>|$)/g, '').trim();
        log(`Response Code: 200 (${secs}s) [compact] summary ready: ${clean.length} characters${rawText.length - clean.length ? ` (removed ${rawText.length - clean.length} characters of tool-call text)` : ''}`);
        if (clean.length < 120) {      // never hand Claude Code a fake summary: it would replace your whole context with it
          if (compactTries < 1 && !ctl.closed) { compactTries++; compactTarget = 120; extraAsks++; log(`[compact] the model returned only ${clean.length} characters: asking again with a smaller history and a stricter instruction`); apply(retransform(transport, fmt, 'Your whole reply must be the written summary, in plain text. Do not call, write or mention any tool call.')); continue; }
          log('[compact] still no usable summary: returning an error so Claude Code keeps your context untouched'); dash.event('error', '/compact produced no summary; context left untouched');
          finish({ status: 'error', httpStatus: 502 }); return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: 'proxy: the model returned an empty summary, so your context was left untouched. Run /compact again.' } });
        }
        const ac = { thinking: content.filter(b => b.type === 'thinking' || b.type === 'redacted_thinking'), text: clean, before: '', textCalls: 0, nativeCalls: 0, tunnelCalls: 0, calls: [], errors: [], refusal: false };
        finish({ httpStatus: 200 }); return sendResponse(res, wantStream, data, buildBlocks(data, ac), false, Buffer.byteLength(upBody));
      }
      let a = analyze(data, tools, natRev);
      log(`Response Code: 200 (${secs}s) - ${a.calls.length} tool call(s)${a.nativeCalls ? ` (${a.nativeCalls} native)` : ''}${a.tunnelCalls ? ' (via system_todo_write tunnel)' : ''}${a.errors.length ? `, ${a.errors.length} unparseable` : ''}${a.refusal ? ', model says it has no such tools' : ''}`);
      // ---- native tool channel: confirmed by the first native call; abandoned if the model just says it has no tools
      if (native) {
        if (a.nativeCalls) { if (state.native !== 'on') { state.native = 'on'; log('native tool channel confirmed: the provider honored a call through the lowercase tool names'); dash.event('native', 'native tool channel confirmed (read/write/edit/bash)'); } state.nativeFails = 0; }
        else if (!a.calls.length && a.refusal && state.native !== 'on' && !ctl.closed) { state.native = 'off'; natNow = false; log('native tool channel not honored by the provider: using the text bridge'); dash.event('fallback', 'native tool channel not honored -> text bridge'); extraAsks++; apply(retransform(transport, fmt)); continue; }
      }
      // ---- proxy-run tools (WebSearch / WebFetch / fetch_image): executed here, results fed back, Claude Code never sees these calls
      const isSrv = c => SERVER_ON && search.SERVER_TOOL_NAMES.has(c.tool.name);
      const sv = a.calls.filter(isSrv);
      if (sv.length) {
        if (serverIter < envNum('SERVER_TOOL_ITERS', 4) && !ctl.closed) {
          serverIter++;
          const results = await Promise.all(sv.map(async c => { const t2 = Date.now(); let r; try { r = await search.runServerTool(c.tool.name, c.params); } catch (e) { r = { ok: false, text: `[${c.tool.name} failed: ${e.message}]` }; }
            dash.tool(recId, c.tool.name, r.ok !== false, summarizeCall(c), { proxy: true, ms: Date.now() - t2 }); serverNames.add(c.tool.name); log(`proxy ran ${c.tool.name}: ${summarizeCall(c)} -> ${r.ok === false ? 'FAILED' : 'ok'} (${((Date.now() - t2) / 1000).toFixed(1)}s${r.provider ? ', ' + r.provider : ''})`); return r; }));
          if (a.calls.length > sv.length) log(`${a.calls.length - sv.length} other tool call(s) in the same reply were set aside: the model re-issues them after it sees the web results`);
          const lead = (a.textCalls ? a.before : (a.nativeCalls ? a.text : '')).trim();
          extraMsgs.push({ role: 'assistant', content: (lead ? lead + '\n\n' : '') + sv.map(c => callXml(c.tool.name, c.params, fmt === 'json' ? 'json' : 'xml')).join('\n') });
          extraMsgs.push({ role: 'user', content: [{ type: 'text', text: results.map((r, i) => `<tool_result tool="${sv[i].tool.name}" id="px${serverIter}${i}">\n${r.text}\n</tool_result>`).join('\n\n') }, ...results.filter(r => r.image).map(r => r.image)] });
          rebase(); extraAsks++; continue;
        }
        log('web tool limit reached for this turn: continuing without further web calls'); { const rest = a.calls.filter(c => !isSrv(c)); a = { ...a, calls: rest, textCalls: rest.filter(c => !c.native).length, nativeCalls: rest.filter(c => c.native).length }; if (!rest.length) a.text = (a.before || '').trim() || '(the web tool limit for this turn was reached; answer from what you already have)'; }
      }
      const elapsed = (Date.now() - t0) / 1000, budgetOk = elapsed < envNum('REASK_BUDGET_S', 150), bigReq = kb > envNum('GUARD_MAX_KB', 300);
      const gate = (what, optional) => { if (optional && bigReq) { log(`not re-asking (${what}): the request is ${kb.toFixed(0)} KB and every re-ask re-sends all of it`); return true; } if (!budgetOk) { log(`not re-asking (${what}): ${elapsed.toFixed(0)}s already spent on this turn`); return true; } return false; };
      if (!a.calls.length && a.refusal && opts.TRANSPORT === 'auto' && transport === 'text' && !ctl.closed) {
        log(`model ignored the text bridge ("${a.text.replace(/\s+/g, ' ').slice(0, 120)}") - switching to the system_todo_write tunnel`);
        transport = 'tunnel'; apply(retransform('tunnel', fmt)); continue;
      }
      if (!a.calls.length && (a.errors.length || a.refusal) && fmtRetries < FORMAT_RETRIES && !ctl.closed && !gate('format', false)) {
        fmtRetries++; stats.extra.format++; extraAsks++; log(`asking the model again (${a.errors.length ? a.errors[0].reason : 'it ignored the bridge'}). It said: "${a.text.replace(/\s+/g, ' ').slice(0, 140)}"`);
        if (a.errors.length) {
          // Parse failure (usually code inside a JSON string). Never send the failed text back; switch to the raw-tag format and resend the ORIGINAL conversation after a short pause.
          if (fmt === 'json') { fmt = 'xml'; state.fmt = 'xml'; log('switching to the raw <param> call format (no JSON escaping) for this and later requests'); }
          apply(retransform(transport, fmt, FMT_NOTE)); await sleep(1500); continue;
        }
        const said = a.text.replace(/<tool_call[\s\S]*?<\/tool_call>/g, '').trim().slice(0, 500);   // refusal prose only, never code
        messages = [...payload.messages, ...extraMsgs, { role: 'assistant', content: said || '(no output)' }, { role: 'user', content: retryNote(a, tools, transport) }]; continue;
      }
      if (!a.calls.length && !a.errors.length && !a.refusal && !side && midLoop && contRetries < CONT_RETRIES && looksUnfinished(a.text) && !ctl.closed && !gate('continue', true)) {
        contRetries++; stats.extra.continue++; extraAsks++; log(`the model stopped mid-task without a tool call (${a.text.trim() ? 'it said: "' + a.text.replace(/\s+/g, ' ').slice(-120) + '"' : 'empty reply'}) - asking again ${contRetries}/${CONT_RETRIES}`);
        apply(retransform(transport, fmt, CONT_NOTE)); await sleep(1000); continue;
      }
      if (!a.calls.length && !a.errors.length && !a.refusal && !side && midLoop && hallRetries < HALL_RETRIES && CLAIM_RE.test(a.text) && !loopUsedWriteTool(body.messages) && !ctl.closed && !gate('claim check', true)) {
        hallRetries++; stats.extra.claim++; extraAsks++; log(`the model claims file changes but made no Edit/Write/shell call in this task ("${a.text.replace(/\s+/g, ' ').slice(0, 120)}") - asking again`);
        apply(retransform(transport, fmt, HALL_NOTE)); await sleep(1000); continue;
      }
      if (a.tunnelCalls && opts.TRANSPORT === 'auto' && !state.tunnel) { state.tunnel = true; log('tunnel works - staying on it for the next requests'); }
      if (!a.calls.length) log(`no tool call. Model said: "${a.text.replace(/\s+/g, ' ').slice(0, 200)}"`);
      else a.calls.forEach((c, i) => { log(`tool call #${i + 1}: ${c.tool.name} ${Object.keys(c.params).join(',')}${c.missing.length ? '  (missing required: ' + c.missing.join(',') + ')' : ''}`); dash.tool(recId, c.tool.name, !c.missing.length, summarizeCall(c), { native: !!c.native }); });
      if (kind0 === 'agent') state.mainModel = payload.model || state.mainModel;
      finish({ httpStatus: 200, native }); return sendResponse(res, wantStream, data, buildBlocks(data, a), a.calls.length > 0, Buffer.byteLength(upBody));
    }
  } catch (e) { log('upstream failure:', e.message); dash.event('error', `upstream failure: ${e.message}`); finish({ status: 'error', httpStatus: 502 }); if (!res.headersSent) sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: `proxy: ${e.message}` } }); else res.end(); }
}

const configSnapshot = () => ({ version: VERSION, build: BUILD, upstream: TARGET.host, model: UP_MODEL || state.mainModel || process.env.ANTHROPIC_MODEL || '',
  nativeMode: nativeMode(), nativeState: nativeMode() === 'off' ? 'off' : (state.native || (nativeMode() === 'on' ? 'on' : 'unknown')), callFormat: state.fmt || CALL_FORMAT,
  autoCompactKB: process.env.AUTO_COMPACT === '0' ? 0 : envNum('AUTO_COMPACT_KB', 260), trimKB: envNum('TRIM_ABOVE_KB', 300), search: search.configured(), keepCache: KEEP_CACHE, serverTools: SERVER_ON });
const hostOk = req => { const h = String(req.headers.host || '').toLowerCase(); return h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}` || h === '127.0.0.1' || h === 'localhost'; };   // blocks DNS-rebinding reads of the dashboard
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
  if (req.method === 'GET' && (url === '/' || url === '/dashboard')) { if (!hostOk(req)) { res.writeHead(403); return res.end(); } res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(DASH_HTML); }
  if (req.method === 'GET' && url === '/api/stats') { if (!hostOk(req)) { res.writeHead(403); return res.end(); } return sendJson(res, 200, dash.snapshot(+(new URL(req.url, 'http://x').searchParams.get('since') || 0))); }
  if (req.method === 'GET' && url === '/api/config') { if (!hostOk(req)) { res.writeHead(403); return res.end(); } return sendJson(res, 200, configSnapshot()); }
  if (req.method === 'POST' && url === '/api/reset') { if (!hostOk(req)) { res.writeHead(403); return res.end(); } dash.reset(); return sendJson(res, 200, { ok: true }); }
  if (req.method === 'GET' && url.startsWith('/v1/models')) return sendJson(res, 200, { data: [{ id: UP_MODEL || state.mainModel || process.env.ANTHROPIC_MODEL || 'claude-opus-4-8', type: 'model' }, { id: 'claude-opus-4-8', type: 'model' }, { id: 'claude-3-5-sonnet-20241022', type: 'model' }].filter((m, i, a) => a.findIndex(x => x.id === m.id) === i) });
  if (req.method === 'GET' && url === '/health') return sendJson(res, 200, { status: 'ok', version: VERSION, build: BUILD, target: TARGET.origin });
  let raw = ''; req.on('data', c => { raw += c; });
  req.on('end', () => {
    if (req.url.includes('/count_tokens')) { let n = 100; try { const b = JSON.parse(raw); n = estTokens(JSON.stringify({ s: b.system, m: b.messages })) + 700; } catch { /* keep */ } return sendJson(res, 200, { input_tokens: n }); }
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); return res.end(); }
    handleMessages(req, res, raw);
  });
});
if (require.main === module) {
  server.on('error', e => { console.error('[Proxy] ' + e.message + (e.code === 'EADDRINUSE' ? `  (port ${PORT} busy: run  npx kill-port ${PORT})` : '')); process.exit(1); });
  server.listen(PORT, '127.0.0.1', () => {
    log(`Claude Code proxy v${VERSION} (build ${BUILD}) running on http://127.0.0.1:${PORT}  ->  ${TARGET.origin}  (call format: ${CALL_FORMAT}, transport: ${opts.TRANSPORT})`);
    log(`dashboard:  http://127.0.0.1:${PORT}/`);
    log(`native tools: ${nativeMode()}${CAP.native ? ` (probe says ${CAP.native.works ? 'works' : 'does not work'})` : ''} | web search: ${search.configured().join(' > ')} | auto-compact above ${process.env.AUTO_COMPACT === '0' ? 'OFF' : envNum('AUTO_COMPACT_KB', 260) + ' KB'} | cache: ${KEEP_CACHE ? 'kept' : 'stripped'}`);
  });
}
module.exports = { server, opts, state, dash, compactor, isCompaction, analyze, transform, assembleSse, reportUsage, usageTotals, trimOldResults, flattenMessages, repairPairs, extractCalls, repairJson, parseCall, buildToolText, nativeMap, configSnapshot };
