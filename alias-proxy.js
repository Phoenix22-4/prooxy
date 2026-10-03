/**
 * Claude Code Local Tool Proxy  v2.1
 * ---------------------------------------------------------------
 * Gives Claude Code working tools behind a provider that strips or
 * blocks native `tools`. Tools are described to the model as compact
 * text (generated from the real schemas Claude Code sends), and the
 * model's <tool_call> blocks are converted back into native tool_use
 * SSE events, so Claude Code runs Bash/Read/Edit/Write locally.
 *
 *   node alias-proxy.js
 *   $env:ANTHROPIC_BASE_URL="http://127.0.0.1:8082"; claude
 *
 * Env: TARGET_URL, PORT, PROXY_DEBUG=1, KEEP_MCP=mcp__unity,mcp__x, PROXY_RETRIES
 */
'use strict';

const http   = require('node:http');
const https  = require('node:https');
const crypto = require('node:crypto');

const VERSION = '2.1.0';
const env     = process.env;
const TARGET  = new URL(env.TARGET_URL || 'https://api.justwoker.icu');
const CFG = {
  PORT          : +(env.PORT || 8082),
  HOST          : '127.0.0.1',
  DEBUG         : env.PROXY_DEBUG === '1',
  MAX_RETRIES   : +(env.PROXY_RETRIES ?? 2),   // model-format repair retries
  UP_RETRIES    : 2,                           // 429/502/503/504/529 + network retries
  IDLE_MS       : 180000,                      // upstream idle timeout
  TC_MAX_CHARS  : 1_000_000,                   // max buffered <tool_call> (big Write)
  TOOL_DESC     : 110,                         // chars of each tool description injected
  DROP_TOOLS    : new Set(['read_tabular', 'system_todo_write']),
  KEEP_MCP      : (env.KEEP_MCP || '').split(',').map(s => s.trim()).filter(Boolean),
};
const RETRY_STATUS = new Set([429, 502, 503, 504, 529]);

// ---------------------------------------------------------------- logging
const hms  = () => new Date().toTimeString().slice(0, 8);
const log  = (...a) => console.log(`\x1b[36m[${hms()}]\x1b[0m`, ...a);
const dbg  = (...a) => CFG.DEBUG && console.log(`\x1b[90m[${hms()}] dbg\x1b[0m`, ...a);
const warn = (...a) => console.warn(`\x1b[33m[${hms()}] warn\x1b[0m`, ...a);
const erro = (...a) => console.error(`\x1b[31m[${hms()}] err\x1b[0m`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const estTokens = s => Math.ceil(String(s).length / 3.6);

// ---------------------------------------------------------------- JSON repair
function sanitize(s) {            // escape raw newlines/tabs inside JSON strings
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { out += ch; esc = false; }
      else if (ch === '\\') { out += ch; esc = true; }
      else if (ch === '"') { out += ch; inStr = false; }
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += ch;
    } else { if (ch === '"') inStr = true; out += ch; }
  }
  return out;
}
function balance(s) {             // close unterminated strings / brackets
  const stack = []; let inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if ((ch === '}' || ch === ']') && stack.length) stack.pop();
  }
  return s + (inStr ? '"' : '') + stack.reverse().join('');
}
const noTrailing = s => s.replace(/,\s*([}\]])/g, '$1');
function repairJson(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1];
  const tries = [x => x, sanitize, x => noTrailing(sanitize(x)), x => noTrailing(balance(sanitize(x)))];
  for (const f of tries) { try { return JSON.parse(f(s)); } catch { /* next */ } }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(noTrailing(sanitize(s.slice(a, b + 1)))); } catch { /* give up */ } }
  return null;
}

// ---------------------------------------------------------------- tool docs (from real schemas)
function typeStr(s, depth = 0) {
  if (!s || typeof s !== 'object') return 'any';
  if (Array.isArray(s.enum)) return s.enum.map(v => JSON.stringify(v)).join('|');
  const t = Array.isArray(s.type) ? s.type.filter(x => x !== 'null').join('|') : s.type;
  if (t === 'array') {
    const it = s.items;
    if (it && it.type === 'object' && it.properties && depth < 2) return `[{${propList(it, depth + 1)}}]`;
    return `${typeStr(it, depth + 1)}[]`;
  }
  if (t === 'object' && s.properties && depth < 2) return `{${propList(s, depth + 1)}}`;
  return t || 'any';
}
function propList(schema, depth) {
  const req = new Set(schema.required || []);
  return Object.entries(schema.properties || {})
    .map(([k, v]) => `${req.has(k) ? '*' : ''}${k}:${typeStr(v, depth)}`).join(', ');
}
function toolDoc(t) {
  const d = String(t.description || '').replace(/\s+/g, ' ').trim();
  let first = d.split(/(?<=[.!?])\s/)[0] || '';
  if (first.length > CFG.TOOL_DESC) first = first.slice(0, CFG.TOOL_DESC - 1) + '…';
  return `${t.name}(${propList(t.input_schema || {}, 0)})${first ? ' — ' + first : ''}`;
}
const CORE_TOOLS = new Set(['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'TodoWrite', 'TodoRead', 'Task', 'Agent', 'Skill', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  'BashOutput', 'KillShell', 'TaskStop', 'Monitor',
  ...(env.EXTRA_TOOLS || '').split(',').map(x => x.trim()).filter(Boolean)]);
function selectTools(tools) {
  return (tools || []).filter(t => t && t.name && !CFG.DROP_TOOLS.has(t.name) &&
    (CORE_TOOLS.has(t.name) || (t.name.startsWith('mcp__') && CFG.KEEP_MCP.some(p => t.name.startsWith(p)))));
}
function buildInjection(tools) {
  return `<proxy_tools>
IMPORTANT: ignore the function list defined by the gateway (read_tabular, system_todo_write). It is NOT your toolset and those functions cannot reach the user's files. Your real tools are the ones listed below. You use them by WRITING the text block shown below: the user's own local software reads your text, runs the tool on their machine, and returns the output in the next message as <tool_result>. This works even though these tools are absent from your function list. Never say you lack tools, never try a native function call for them, and never use read_tabular or system_todo_write.

FORMAT (plain text, not a code block; values are raw, no JSON escaping or quoting):
<tool_call name="Edit">
<param name="file_path">C:\\path\\File.cs</param>
<param name="old_string">
exact existing text
</param>
<param name="new_string">
replacement text
</param>
</tool_call>

RULES
- Multi-line values go on their own lines between the tags; one leading and one trailing newline are ignored, everything else (indentation, quotes, backslashes) is kept exactly.
- number/boolean params: plain text (30, true). array/object params: JSON.
- Independent calls may be emitted together as several <tool_call> blocks; then STOP and wait. Results arrive next turn as <tool_result> blocks. Never write <tool_result> yourself and never guess an output.
- Don't narrate a plan you can execute; call the tool. Keep working until the task is done.

TOOLS (* = required)
${tools.map(toolDoc).join('\n')}
</proxy_tools>`;
}

// ---------------------------------------------------------------- param parsing
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = { path: 'file_path', filepath: 'file_path', file: 'file_path', cmd: 'command',
  contents: 'content', text: 'content', old: 'old_string', oldstring: 'old_string',
  new: 'new_string', newstring: 'new_string', replaceall: 'replace_all' };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const trimOne = s => s.replace(/^\r?\n/, '').replace(/\r?\n$/, '');

function parseParams(body) {
  const re = /<param\s+name\s*=\s*(?:"([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/param>/g;
  const out = {}; let m, found = false;
  while ((m = re.exec(body))) { found = true; out[m[1] || m[2]] = trimOne(m[3]); }
  if (found) return out;
  return body.trim() === '' ? {} : null;
}
function coerce(v, schema) {
  const t = schema && schema.type;
  if (v == null || !t) return v;
  if (typeof v === 'string') {
    if (t === 'number' || t === 'integer') { const n = Number(v.trim()); return v.trim() !== '' && Number.isFinite(n) ? n : v; }
    if (t === 'boolean') { const s = v.trim().toLowerCase(); return s === 'true' ? true : s === 'false' ? false : v; }
    if (t === 'array' || t === 'object') { const j = repairJson(v); return j !== null && typeof j === 'object' ? j : v; }
  } else if (t === 'string') return typeof v === 'object' ? JSON.stringify(v) : String(v);
  return v;
}
function normalizeParams(tool, params) {
  const props = (tool.input_schema && tool.input_schema.properties) || {};
  const byNorm = {}; for (const k of Object.keys(props)) byNorm[norm(k)] = k;
  const out = {};
  for (const [k0, v] of Object.entries(params)) {
    let k = k0;
    if (!has(props, k0)) {
      const a = has(ALIASES, norm(k0)) ? ALIASES[norm(k0)] : null;
      k = byNorm[norm(k0)] || (a && has(props, a) ? a : k0);
    }
    out[k] = coerce(v, props[k]);
  }
  // POSIX habit: multi-line file content ends with a newline
  if (tool.name === 'Write' && typeof out.content === 'string' && out.content.includes('\n') && !out.content.endsWith('\n')) out.content += '\n';
  return out;
}
function findTool(name, tools) {
  return tools.find(t => t.name === name) || tools.find(t => t.name.toLowerCase() === String(name).toLowerCase());
}
function parseCall(tag, body, tools) {
  const na = /\bname\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(tag);
  let name, params;
  if (na) {
    name = na[1] || na[2];
    params = parseParams(body);
    if (!params) {
      const j = repairJson(body);
      if (j && typeof j === 'object') params = j.parameters ?? j.params ?? j.input ?? j.arguments ?? j.args ?? j;
    }
  } else {
    const j = repairJson(body);
    if (j && typeof j === 'object') { name = j.name ?? j.tool; params = j.parameters ?? j.params ?? j.input ?? j.arguments ?? j.args ?? {}; }
    else { const m = /<name>\s*([^<\s]+)\s*<\/name>/.exec(body); if (m) { name = m[1]; params = parseParams(body) || {}; } }
  }
  if (!name) return { error: 'no tool name found' };
  if (!params || typeof params !== 'object') return { error: 'could not read parameters' };
  const tool = findTool(name, tools);
  if (!tool) return { error: `unknown tool "${name}"`, unknown: name };
  const p = normalizeParams(tool, params);
  const missing = ((tool.input_schema && tool.input_schema.required) || []).filter(k => !has(p, k));
  return { tool, params: p, missing };
}

// ---------------------------------------------------------------- stream parser (text -> text / calls)
const OPEN = '<tool_call', CLOSE = '</tool_call>';
class CallParser {
  constructor(h) { this.h = h; this.buf = ''; this.inCall = false; this.tag = ''; this.afterCall = false; this.stopped = false; }
  text(s) {
    if (!s) return;
    if (this.afterCall) { if (s.trim()) { this.stopped = true; this.h.stray(s); } return; }
    this.h.text(s);
  }
  push(t) { if (!this.stopped) { this.buf += t; this.drain(); } }
  drain() {
    for (;;) {
      if (this.stopped) return;
      if (!this.inCall) {
        const i = this.buf.indexOf(OPEN);
        if (i === -1) {            // hold back a possible partial "<tool_call"
          let keep = 0;
          for (let n = Math.min(OPEN.length - 1, this.buf.length); n > 0; n--) if (OPEN.startsWith(this.buf.slice(-n))) { keep = n; break; }
          this.text(this.buf.slice(0, this.buf.length - keep));
          this.buf = this.buf.slice(this.buf.length - keep);
          return;
        }
        if (this.buf.length < i + OPEN.length + 1) { this.text(this.buf.slice(0, i)); this.buf = this.buf.slice(i); return; }
        const next = this.buf[i + OPEN.length];
        if (next !== '>' && !/\s/.test(next)) {   // e.g. "<tool_calls": ordinary text
          this.text(this.buf.slice(0, i + OPEN.length)); this.buf = this.buf.slice(i + OPEN.length); continue;
        }
        const gt = this.buf.indexOf('>', i);
        this.text(this.buf.slice(0, i));
        if (gt === -1) { this.buf = this.buf.slice(i); return; }
        this.tag = this.buf.slice(i, gt + 1);
        this.buf = this.buf.slice(gt + 1);
        this.inCall = true;
      } else {
        const e = this.buf.indexOf(CLOSE);
        if (e === -1) {
          if (this.buf.length > CFG.TC_MAX_CHARS) { this.h.bad(this.tag + this.buf, 'tool call too long'); this.buf = ''; this.inCall = false; }
          return;
        }
        const body = this.buf.slice(0, e);
        const raw = this.tag + body + CLOSE;
        this.buf = this.buf.slice(e + CLOSE.length);
        this.inCall = false;
        this.h.call(this.tag, body, raw, false);
      }
    }
  }
  end(lenient) {
    if (this.inCall) {
      const raw = this.tag + this.buf;
      this.inCall = false;
      if (lenient) this.h.call(this.tag, this.buf, raw, true);
      else this.h.bad(raw, 'output cut off inside the tool call');
      this.buf = '';
    } else if (this.buf && !this.stopped) { const b = this.buf; this.buf = ''; this.text(b); }
  }
}

// ---------------------------------------------------------------- request transform
const shortId = id => String(id || '').slice(-6);
function callXml(name, input) {
  const ps = Object.entries(input || {}).map(([k, v]) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.includes('\n') ? `<param name="${k}">\n${s}\n</param>` : `<param name="${k}">${s}</param>`;
  }).join('\n');
  return `<tool_call name="${name}">\n${ps}\n</tool_call>`;
}
const stripCC = ({ cache_control, ...rest }) => rest;

function flattenMessages(messages) {
  const idName = new Map(), out = [], fake = new Set();
  for (const m of messages) {
    const src = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (Array.isArray(m.content) ? m.content : []);
    const parts = []; let cc = null;
    const addText = t => { if (t && t.trim()) parts.push({ type: 'text', text: t }); };
    for (const b of src) {
      if (!b || typeof b !== 'object') continue;
      if (b.cache_control) cc = b.cache_control;
      if (b.type === 'text') addText(b.text);
      else if (b.type === 'tool_use') { if (CFG.DROP_TOOLS.has(b.name)) fake.add(b.id); else { idName.set(b.id, b.name); addText(callXml(b.name, b.input)); } }
      else if (b.type === 'tool_result') {
        if (fake.has(b.tool_use_id)) continue;
        let txt = ''; const media = [];
        if (typeof b.content === 'string') txt = b.content;
        else if (Array.isArray(b.content)) {
          for (const x of b.content) {
            if (x && x.type === 'text') txt += (txt ? '\n' : '') + x.text;
            else if (x && (x.type === 'image' || x.type === 'document')) media.push(stripCC(x));
            else if (x != null) txt += (txt ? '\n' : '') + JSON.stringify(x);
          }
        } else if (b.content != null) txt = JSON.stringify(b.content);
        const nm = idName.get(b.tool_use_id);
        addText(`<tool_result${nm ? ` tool="${nm}"` : ''} id="${shortId(b.tool_use_id)}"${b.is_error ? ' error="true"' : ''}>\n${txt || '(no output)'}\n</tool_result>`);
        parts.push(...media);
      } else if (b.type === 'image' || b.type === 'document') parts.push(stripCC(b));
      // thinking / redacted_thinking / server tool blocks: dropped (saves tokens, never re-sent natively either)
    }
    if (!parts.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.parts.push(...parts); else out.push({ role: m.role, parts, cc });
    if (cc) out[out.length - 1].cc = cc;
  }
  return out.map(({ role, parts, cc }) => {
    const merged = [];
    for (const p of parts) {
      const l = merged[merged.length - 1];
      if (p.type === 'text' && l && l.type === 'text') l.text += '\n\n' + p.text; else merged.push({ ...p });
    }
    if (cc) merged[merged.length - 1].cache_control = cc;
    return { role, content: merged.length === 1 && merged[0].type === 'text' && !cc ? merged[0].text : merged };
  });
}

function addReminder(messages, tools) {
  const note = `\n\n[proxy] Your real tools (absent from your function list, but executed by the user's local software from your TEXT): ${tools.map(t => t.name).join(', ')}. To use one, write <tool_call name="Tool"><param name="x">value</param></tool_call> as plain text (see <proxy_tools>). Do not use native function calls and do not claim you lack tools.`;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]; if (m.role !== 'user') continue;
    if (typeof m.content === 'string') m.content += note;
    else { const t = [...m.content].reverse().find(b => b.type === 'text'); if (t) t.text += note; else m.content.push({ type: 'text', text: note.trim() }); }
    return;
  }
}
function transformRequest(raw) {
  const p = JSON.parse(JSON.stringify(raw));
  const tools = selectTools(p.tools);
  const total = (p.tools || []).length;
  delete p.tools; delete p.tool_choice; delete p.context_management;
  if (tools.length) {
    const inj = buildInjection(tools);
    if (Array.isArray(p.system)) p.system.push({ type: 'text', text: inj });
    else p.system = (p.system ? p.system + '\n\n' : '') + inj;
    log(`[req] tools ${tools.length}/${total} kept (${tools.map(t => t.name).join(', ')})  injection ≈ ${estTokens(inj)} tokens`);
    dbg('[req] system tail:', JSON.stringify(inj.slice(0, 200)));
  }
  if (Array.isArray(p.messages)) p.messages = flattenMessages(p.messages);
  if (tools.length && Array.isArray(p.messages)) addReminder(p.messages, tools);
  return { payload: p, tools };
}

// ---------------------------------------------------------------- session: upstream events -> client events
function createSession({ sink, tools, abort }) {
  const S = { nextIdx: 0, textIdx: null, think: new Map(), upTools: new Map(), calls: 0, bad: null,
    skipped: [], visible: '', started: false, stopReason: null, outTok: 0, parser: null, aborted: false };

  const closeText = () => { if (S.textIdx !== null) { sink('content_block_stop', { type: 'content_block_stop', index: S.textIdx }); S.textIdx = null; } };
  const emitText = s => {
    if (!s) return;
    if (S.textIdx === null) {
      S.textIdx = S.nextIdx++;
      sink('content_block_start', { type: 'content_block_start', index: S.textIdx, content_block: { type: 'text', text: '' } });
    }
    S.visible += s;
    sink('content_block_delta', { type: 'content_block_delta', index: S.textIdx, delta: { type: 'text_delta', text: s } });
  };
  const emitToolUse = (tool, params) => {
    closeText();
    const idx = S.nextIdx++, id = `toolu_${crypto.randomBytes(12).toString('hex')}`;
    S.calls++; if (S.parser) S.parser.afterCall = true;
    log(`[call] #${S.calls} ${tool.name}  ${Object.keys(params).join(',')}`);
    sink('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id, name: tool.name, input: {} } });
    sink('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(params) } });
    sink('content_block_stop', { type: 'content_block_stop', index: idx });
  };
  const bad = (raw, reason, unknown) => {
    warn(`[parse] rejected: ${reason}`); dbg(raw.slice(0, 300));
    if (S.calls > 0) S.skipped.push(reason); else if (!S.bad) S.bad = { raw, reason, unknown };
  };
  const onCall = (tag, body, raw, lenient) => {
    const r = parseCall(tag, body, tools);
    if (r.error) return bad(raw, r.error, r.unknown);
    if (lenient && r.missing.length) return bad(raw, 'call incomplete (missing ' + r.missing.join(',') + ')');
    if (r.missing.length) warn(`[call] ${r.tool.name} missing required: ${r.missing.join(',')} (Claude Code will report it to the model)`);
    emitToolUse(r.tool, r.params);
  };
  const handlers = {
    text: emitText, call: onCall, bad,
    stray: s => { warn('[parse] text after tool call (model tried to continue without results) — cutting upstream'); dbg(s.slice(0, 120)); S.aborted = true; abort(); },
  };

  return {
    S,
    beginAttempt() { S.parser = new CallParser(handlers); S.parser.afterCall = S.calls > 0; S.bad = null; S.upTools.clear(); S.aborted = false; },
    onUpstream(ev) {
      switch (ev.type) {
        case 'message_start':
          if (!S.started) { S.started = true; sink('message_start', { ...ev, message: { ...ev.message, content: [] } }); }
          break;
        case 'ping': sink('ping', ev); break;
        case 'error': sink('error', ev); break;
        case 'content_block_start': {
          const k = ev.content_block && ev.content_block.type;
          if (k === 'thinking' || k === 'redacted_thinking') {
            closeText();
            const idx = S.nextIdx++; S.think.set(ev.index, idx);
            sink('content_block_start', { ...ev, index: idx });
          } else if (k === 'tool_use') S.upTools.set(ev.index, { name: ev.content_block.name, json: '' });
          break;                                   // text blocks open lazily on first real text
        }
        case 'content_block_delta': {
          const d = ev.delta || {};
          if (d.type === 'text_delta') S.parser.push(d.text || '');
          else if (d.type === 'thinking_delta' || d.type === 'signature_delta') {
            if (S.think.has(ev.index)) sink('content_block_delta', { ...ev, index: S.think.get(ev.index) });
          } else if (d.type === 'input_json_delta' && S.upTools.has(ev.index)) S.upTools.get(ev.index).json += d.partial_json || '';
          break;
        }
        case 'content_block_stop':
          if (S.think.has(ev.index)) { sink('content_block_stop', { ...ev, index: S.think.get(ev.index) }); S.think.delete(ev.index); }
          else if (S.upTools.has(ev.index)) {     // provider-side native tool_use
            const u = S.upTools.get(ev.index); S.upTools.delete(ev.index);
            const tool = findTool(u.name, tools);
            const input = u.json ? repairJson(u.json) : {};
            if (tool && input && typeof input === 'object') emitToolUse(tool, normalizeParams(tool, input));
            else bad(callXml(u.name, input || {}), `unknown tool "${u.name}"`, u.name);
          }
          break;
        case 'message_delta':
          S.stopReason = (ev.delta && ev.delta.stop_reason) || S.stopReason;
          if (ev.usage && ev.usage.output_tokens) S.outTok += ev.usage.output_tokens;
          break;
        default: break;
      }
    },
    endAttempt() {
      S.parser.end(S.stopReason !== 'max_tokens' && !S.aborted);
      if (S.stopReason === 'max_tokens' && S.bad) S.bad.reason = 'output hit the length limit mid-call; split big edits into smaller ones';
    },
    needsRetry() { return !!S.bad && S.calls === 0; },
    retryMessages(base) {
      const b = S.bad;
      const note = b.unknown
        ? `[proxy] Tool "${b.unknown}" does not exist. Use only: ${tools.map(t => t.name).join(', ')}. Re-send the call now as a <tool_call name="..."> block.`
        : `[proxy] Your last <tool_call> was rejected (${b.reason}). Re-send only the corrected <tool_call name="..."> block with <param name="..."> tags.`;
      return [...base, { role: 'assistant', content: ((S.visible ? S.visible + '\n' : '') + b.raw) || '(tool call)' }, { role: 'user', content: note }];
    },
    finish(upstreamOk = true) {
      closeText();
      if (S.bad) emitText(`\n⚠ [proxy] could not run a tool call (${S.bad.reason}). Raw:\n${S.bad.raw}\n`);
      if (S.skipped.length) emitText(`\n⚠ [proxy] ${S.skipped.length} tool call(s) in this turn were malformed and skipped (${S.skipped.join('; ')}). Re-issue them.\n`);
      closeText();
      const stop = S.calls > 0 ? 'tool_use' : (S.stopReason && S.stopReason !== 'tool_use' ? S.stopReason : 'end_turn');
      sink('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: S.outTok || estTokens(S.visible) } });
      sink('message_stop', { type: 'message_stop' });
      log(`[done] stop=${stop} calls=${S.calls}${S.calls ? '' : ' text="' + S.visible.replace(/\s+/g, ' ').slice(0, 160) + '"'}`);
    },
  };
}

function makeCollector() {   // non-streaming clients: fold events into one message object
  let msg = null; const blocks = []; let stop = null, usage = null;
  return {
    sink(name, d) {
      if (name === 'message_start') msg = d.message;
      else if (name === 'content_block_start') blocks[d.index] = { ...d.content_block, _j: '' };
      else if (name === 'content_block_delta') {
        const b = blocks[d.index], x = d.delta; if (!b) return;
        if (x.type === 'text_delta') b.text += x.text;
        else if (x.type === 'thinking_delta') b.thinking = (b.thinking || '') + x.thinking;
        else if (x.type === 'signature_delta') b.signature = x.signature;
        else if (x.type === 'input_json_delta') b._j += x.partial_json;
      } else if (name === 'content_block_stop') {
        const b = blocks[d.index]; if (b && b.type === 'tool_use') b.input = b._j ? JSON.parse(b._j) : {};
      } else if (name === 'message_delta') { stop = d.delta.stop_reason; usage = d.usage; }
    },
    result() {
      return { ...(msg || { id: 'msg_proxy', type: 'message', role: 'assistant', model: 'unknown' }),
        content: blocks.filter(Boolean).map(({ _j, ...b }) => b), stop_reason: stop, stop_sequence: null,
        usage: { ...((msg && msg.usage) || {}), ...(usage || {}) } };
    },
  };
}

// ---------------------------------------------------------------- upstream plumbing
const transport = TARGET.protocol === 'http:' ? http : https;
function upstreamHeaders(req, bodyLen) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'content-length', 'accept-encoding', 'connection', 'transfer-encoding', 'keep-alive'].includes(k.toLowerCase())) continue;
    h[k.toLowerCase()] = v;
  }
  h.host = TARGET.host;
  if (bodyLen != null) { h['content-length'] = bodyLen; h['content-type'] = 'application/json'; }
  return h;
}
function upstreamOnce(path, method, headers, body, ctl) {
  return new Promise((resolve, reject) => {
    const r = transport.request({ hostname: TARGET.hostname, port: TARGET.port || (TARGET.protocol === 'http:' ? 80 : 443), path, method, headers }, resolve);
    ctl.req = r;
    r.setTimeout(CFG.IDLE_MS, () => r.destroy(new Error('upstream idle timeout')));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
async function openUpstream(path, method, headers, body, ctl) {
  for (let i = 0; ; i++) {
    try {
      const res = await upstreamOnce(path, method, headers, body, ctl);
      if (RETRY_STATUS.has(res.statusCode) && i < CFG.UP_RETRIES && !ctl.closed) {
        res.resume(); warn(`[up] ${res.statusCode} — retry ${i + 1}/${CFG.UP_RETRIES}`); await sleep(500 * (i + 1)); continue;
      }
      return res;
    } catch (e) {
      if (i < CFG.UP_RETRIES && !ctl.closed) { warn(`[up] ${e.message} — retry ${i + 1}/${CFG.UP_RETRIES}`); await sleep(500 * (i + 1)); continue; }
      throw e;
    }
  }
}
function pump(up, onEvent, ctl) {           // parse upstream SSE (UTF-8 safe) and feed events
  return new Promise(resolve => {
    up.setEncoding('utf8');
    ctl.abortUp = () => up.destroy();
    let buf = '';
    const block = b => {
      let data = '';
      for (const line of b.split('\n')) if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
      if (!data || data === '[DONE]') return;
      let ev; try { ev = JSON.parse(data); } catch { return dbg('[sse] unparsable', data.slice(0, 120)); }
      onEvent(ev);
    };
    up.on('data', chunk => {
      buf = (buf + chunk).replace(/\r\n/g, '\n');
      let i; while ((i = buf.indexOf('\n\n')) !== -1) { const b = buf.slice(0, i); buf = buf.slice(i + 2); block(b); }
    });
    const done = () => { if (buf.trim()) { const b = buf; buf = ''; block(b); } resolve(); };
    up.on('end', done); up.on('close', done); up.on('error', done);
  });
}

// ---------------------------------------------------------------- handlers
function readBody(req) {
  return new Promise((resolve, reject) => { const c = []; req.on('data', x => c.push(x)); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); });
}
const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

async function handleMessages(req, res, raw) {
  let payload; try { payload = JSON.parse(raw.toString()); } catch { return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad JSON' } }); }
  const wantStream = payload.stream !== false;
  const { payload: base, tools } = transformRequest(payload);
  const ctl = { closed: false, req: null, abortUp: null };
  res.on('close', () => { if (!res.writableEnded) { ctl.closed = true; if (ctl.abortUp) ctl.abortUp(); if (ctl.req) ctl.req.destroy(); log('[client] disconnected — upstream cancelled'); } });

  const collector = wantStream ? null : makeCollector();
  let headersSent = false;
  const sink = (name, data) => {
    if (collector) return collector.sink(name, data);
    if (!res.writableEnded && !ctl.closed) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const sess = createSession({ sink, tools, abort: () => ctl.abortUp && ctl.abortUp() });
  let messages = base.messages;

  try {
    for (let attempt = 0; ; attempt++) {
      const body = JSON.stringify({ ...base, messages, stream: true });
      log(`[→] ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB  attempt ${attempt + 1}`);
      const up = await openUpstream(req.url, 'POST', upstreamHeaders(req, Buffer.byteLength(body)), body, ctl);
      if (up.statusCode !== 200) {
        if (headersSent) { up.resume(); break; }
        log(`[←] ${up.statusCode} (passthrough)`);
        const h = {}; for (const [k, v] of Object.entries(up.headers)) if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) h[k] = v;
        res.writeHead(up.statusCode, h); up.pipe(res); return;
      }
      if (!headersSent && wantStream) {
        const h = {}; for (const [k, v] of Object.entries(up.headers)) if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'content-type', 'cache-control'].includes(k)) h[k] = v;
        res.writeHead(200, { ...h, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      }
      headersSent = true;
      sess.beginAttempt();
      await pump(up, ev => sess.onUpstream(ev), ctl);
      sess.endAttempt();
      if (sess.needsRetry() && attempt < CFG.MAX_RETRIES && !ctl.closed) {
        log(`[retry] ${sess.S.bad.reason} — asking the model to re-send (${attempt + 1}/${CFG.MAX_RETRIES})`);
        messages = sess.retryMessages(base.messages); continue;
      }
      break;
    }
    sess.finish();
  } catch (e) {
    erro('upstream failure:', e.message);
    if (!headersSent) return sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: `proxy: ${e.message}` } });
    sess.finish();
  }
  if (collector) sendJson(res, 200, collector.result()); else res.end();
}

async function handleCountTokens(req, res, raw) {
  let p; try { p = JSON.parse(raw.toString()); } catch { return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad JSON' } }); }
  const { payload } = transformRequest(p);
  sendJson(res, 200, { input_tokens: estTokens(JSON.stringify({ s: payload.system, m: payload.messages })) });
}

async function passthrough(req, res, raw) {       // /v1/models etc.
  const ctl = { closed: false };
  try {
    const up = await openUpstream(req.url, req.method, upstreamHeaders(req, raw.length ? raw.length : null), raw.length ? raw : null, ctl);
    const h = {}; for (const [k, v] of Object.entries(up.headers)) if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) h[k] = v;
    res.writeHead(up.statusCode, h); up.pipe(res);
  } catch (e) { sendJson(res, 502, { type: 'error', error: { type: 'api_error', message: e.message } }); }
}

const server = http.createServer(async (req, res) => {
  try {
    const p = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && p === '/health')
      return sendJson(res, 200, { status: 'ok', version: VERSION, target: TARGET.origin, uptime: Math.floor(process.uptime()) });
    const raw = await readBody(req);
    if (req.method === 'POST' && p === '/v1/messages') return await handleMessages(req, res, raw);
    if (req.method === 'POST' && p === '/v1/messages/count_tokens') return await handleCountTokens(req, res, raw);
    return await passthrough(req, res, raw);
  } catch (e) { erro('handler:', e.stack || e.message); if (!res.headersSent) sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: e.message } }); else res.end(); }
});

if (require.main === module) {
  server.on('error', e => { erro(e.message); if (e.code === 'EADDRINUSE') erro(`Port ${CFG.PORT} busy. Run: npx kill-port ${CFG.PORT}`); process.exit(1); });
  server.listen(CFG.PORT, CFG.HOST, () => {
    log(`Claude Code Tool Proxy v${VERSION}  http://${CFG.HOST}:${CFG.PORT}  ->  ${TARGET.origin}`);
    log(`MCP tools kept: ${CFG.KEEP_MCP.length ? CFG.KEEP_MCP.join(', ') : 'none (set KEEP_MCP=mcp__prefix to keep some)'}`);
    log('PowerShell:  $env:ANTHROPIC_BASE_URL="http://127.0.0.1:' + CFG.PORT + '"; claude');
  });
}
module.exports = { server, repairJson, parseCall, CallParser, transformRequest, flattenMessages, buildInjection, CFG };
