'use strict';
/**
 * Proxy-side auto-compaction.
 *
 * Claude Code re-sends the WHOLE session on every request, and this relay bills every token again each time.
 * Native auto-compact never fires through a proxy (Claude Code does not know the real context size), so the proxy does it:
 *
 *   - The OLD part of the history is replaced, in what is sent upstream, by a written summary ("notes").
 *   - The most recent messages are kept word for word.
 *   - Claude Code's own history is untouched (nothing is lost locally; only the upstream copy is smaller).
 *   - Notes are cached by a fingerprint of the old messages, so later requests reuse them for free, and are re-written
 *     (merged with the new events) only when the verbatim tail has grown past COMPACT_TAIL_MAX_KB.
 *
 * Boundaries: the first message is always kept (it holds the task and CLAUDE.md); the kept window always starts at an
 * assistant message, so tool_use / tool_result pairs are never split and roles keep alternating.
 */
const crypto = require('node:crypto');
const num = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : +process.env[k]);
const conf = () => ({
  on: process.env.AUTO_COMPACT !== '0' && num('AUTO_COMPACT_KB', 260) > 0,
  triggerBytes: num('AUTO_COMPACT_KB', 260) * 1024, keepBytes: num('COMPACT_KEEP_KB', 80) * 1024, tailMax: num('COMPACT_TAIL_MAX_KB', 150) * 1024,
  keepMin: num('COMPACT_KEEP_MIN', 8), chunkBytes: num('COMPACT_CHUNK_KB', 110) * 1024, summaryChars: num('COMPACT_SUMMARY_CHARS', 7000), cooldownMs: num('COMPACT_COOLDOWN_S', 60) * 1000,
});

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const stripReminders = s => String(s || '').replace(REMINDER_RE, '').trim();
const sha = s => crypto.createHash('sha1').update(s).digest('hex');
const blocksOf = m => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content.filter(Boolean) : []);
const bytes = m => Buffer.byteLength(JSON.stringify(m));
const clip = (s, n, tail = 0) => { s = String(s); if (s.length <= n) return s; const t = Math.min(tail, n >> 2); return s.slice(0, n - t) + `… [+${s.length - n} chars]` + (t ? '\n…' + s.slice(-t) : ''); };

function blockText(b) {
  if (b.type === 'text') return b.text || '';
  if (b.type === 'tool_use') return JSON.stringify(b.input || {});
  if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(x => (x && x.text) || '').join('\n') : JSON.stringify(b.content || '');
  return '';
}
// Identity of a message that survives Claude Code moving cache_control markers or adding <system-reminder>s.
function fingerprint(m) { return m.role + '|' + blocksOf(m).map(b => `${b.type}:${b.id || b.tool_use_id || ''}:${stripReminders(blockText(b)).length}`).join(','); }

function paramSummary(input) {
  return Object.entries(input || {}).map(([k, v]) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length <= 110 ? `${k}=${JSON.stringify(s)}` : `${k}=<${s.length} chars>`; }).join(', ');
}
function render(msgs) {   // transcript text for the summarizer: short, readable, no tool-call syntax to imitate
  const out = [];
  for (const m of msgs) {
    const label = m.role === 'user' ? 'USER' : 'ASSISTANT';
    for (const b of blocksOf(m)) {
      if (b.type === 'text') { const t = stripReminders(b.text); if (t) out.push(`${label}: ${clip(t, m.role === 'user' ? 2500 : 1800)}`); }
      else if (b.type === 'tool_use') out.push(`ASSISTANT ran ${b.name}(${paramSummary(b.input)})`);
      else if (b.type === 'tool_result') out.push(`RESULT${b.is_error ? ' (ERROR)' : ''}: ${clip(stripReminders(blockText(b)), 700, 150)}`);
      else if (b.type === 'image') out.push(`${label}: [image]`);
    }
  }
  return out.join('\n');
}

const SUMMARY_SYSTEM = `You compress the transcript of a coding-agent session into working notes that the same agent will rely on after the old messages are removed.
Write plain text only. Never write tool-call syntax or XML tags. Never invent facts: only use what the transcript shows.
Be exact: keep file paths, class/function/variable names, commands, error messages, numbers and decisions word for word.
Use these sections, skipping empty ones:
1. USER'S GOALS AND INSTRUCTIONS (every request, rule and constraint the user gave, near-verbatim)
2. WORK DONE (files created/edited with what changed and why; commands run and their outcomes)
3. KEY FACTS (architecture, APIs, findings the agent will need again)
4. ERRORS AND FIXES (what failed, the cause, what fixed it)
5. VERIFIED STATE (what compiled / passed / is confirmed working, and what is NOT verified)
6. OPEN TASKS AND NEXT STEP (what remains, in order; the exact step in progress)`;

function userPrompt(prevNotes, firstMsgText, transcript, maxChars) {
  return `${prevNotes ? `CURRENT NOTES (older events, already summarized):\n${prevNotes}\n\n` : ''}${firstMsgText ? `ORIGINAL REQUEST (kept separately, for context only):\n${clip(firstMsgText, 3000)}\n\n` : ''}NEW TRANSCRIPT TO FOLD IN:\n${transcript}\n\nWrite the updated notes, merging the current notes with the new transcript. Maximum ${maxChars} characters. Keep what the agent still needs; drop chatter and anything fully superseded.`;
}

function createCompactor({ log = () => {}, onEvent = () => {} } = {}) {
  const entries = [];            // { upTo, hash, summary, ts }
  let chain = Promise.resolve(), failedAt = 0;

  function chooseCut(raw, sizes, c) {
    let acc = 0, w = raw.length;
    while (w > 1 && (acc < c.keepBytes || raw.length - w < c.keepMin)) { w--; acc += sizes[w]; }
    if (raw[w] && raw[w].role !== 'assistant') w++;       // keep the window starting at an assistant message
    return w;
  }
  function build(raw, entry) {
    const first = raw[0], blocks = blocksOf(first).map(b => ({ ...b }));
    blocks.push({ type: 'text', text: `\n\n<proxy-session-summary>\nThe earlier part of this session (messages 2-${entry.upTo}) was compressed by the local proxy to save tokens. Working notes:\n\n${entry.summary}\n\nThe most recent messages follow exactly as they happened. If you need exact file contents or command output from the earlier part, read/run it again rather than relying on memory of details that are not in these notes.\n</proxy-session-summary>` });
    return [{ ...first, content: blocks }, ...raw.slice(entry.upTo)];
  }

  async function _apply(raw, ask) {
    const c = conf(); if (!c.on || !Array.isArray(raw) || raw.length < c.keepMin + 3 || raw[0].role !== 'user') return null;
    const sizes = raw.map(bytes), total = sizes.reduce((a, b) => a + b, 0), fps = raw.map(fingerprint);
    let entry = null;
    for (const e of entries) if (e.upTo < raw.length - 1 && sha(fps.slice(0, e.upTo).join('\n')) === e.hash && (!entry || e.upTo > entry.upTo)) entry = e;
    const tail = entry ? sizes.slice(entry.upTo).reduce((a, b) => a + b, 0) : total;
    const result = (e, summarized, ms = 0) => { const msgs = build(raw, e); return { messages: msgs, info: { fromKB: total / 1024, toKB: msgs.reduce((a, m) => a + bytes(m), 0) / 1024, upTo: e.upTo, summaryChars: e.summary.length, summarized, ms } }; };
    if (entry && tail <= c.tailMax) return result(entry, false);
    if (!entry && total <= c.triggerBytes) return null;
    const w = chooseCut(raw, sizes, c), from = entry ? entry.upTo : 1;
    if (w <= from + 1 || w >= raw.length - 1) return entry ? result(entry, false) : null;          // nothing worth summarizing yet
    if (Date.now() - failedAt < c.cooldownMs) return entry ? result(entry, false) : null;

    const t0 = Date.now();
    try {
      const firstText = stripReminders(blocksOf(raw[0]).filter(b => b.type === 'text').map(b => b.text).join('\n'));
      const slice = raw.slice(from, w); let notes = entry ? entry.summary : '', chunk = [], chunkBytes = 0; const chunks = [];
      for (const m of slice) { const t = render([m]); if (chunk.length && chunkBytes + t.length > c.chunkBytes) { chunks.push(chunk.join('\n')); chunk = []; chunkBytes = 0; } chunk.push(t); chunkBytes += t.length; }
      if (chunk.length) chunks.push(chunk.join('\n'));
      for (const tr of chunks) {
        let text = await ask(SUMMARY_SYSTEM, userPrompt(notes, firstText, tr, c.summaryChars), 3500);
        text = String(text || '').trim();
        if (text.length < 200 || /<tool_call|<invoke/i.test(text)) throw new Error(`summary came back unusable (${text.length} chars)`);
        notes = text.length > c.summaryChars * 1.4 ? text.slice(0, Math.floor(c.summaryChars * 1.4)) + '\n[notes cut]' : text;
      }
      const e = { upTo: w, hash: sha(fps.slice(0, w).join('\n')), summary: notes, ts: Date.now() };
      entries.push(e); while (entries.length > 6) entries.shift();
      const r = result(e, true, Date.now() - t0);
      log(`[auto-compact] history ${(total / 1024).toFixed(0)} KB -> notes ${notes.length} chars + last ${raw.length - w} messages = ${r.info.toKB.toFixed(0)} KB (${chunks.length} summarizer call(s), ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      onEvent('compaction', `history ${(total / 1024).toFixed(0)} KB -> ${r.info.toKB.toFixed(0)} KB (notes ${notes.length} chars, kept last ${raw.length - w} messages)`, { fromKB: total / 1024, toKB: r.info.toKB });
      return r;
    } catch (err) {
      failedAt = Date.now();
      log(`[auto-compact] failed (${err.message}); using trimming only for ${c.cooldownMs / 1000}s`);
      onEvent('compaction-failed', err.message);
      return entry ? result(entry, false) : null;
    }
  }
  function apply(raw, ask) { const run = chain.then(() => _apply(raw, ask)); chain = run.catch(() => {}); return run; }   // one at a time: parallel requests share the same notes
  return { apply, entries, reset: () => { entries.length = 0; failedAt = 0; }, _internal: { render, fingerprint, chooseCut, conf } };
}

module.exports = { createCompactor, render, fingerprint };
