'use strict';
/**
 * Live statistics for the dashboard. Pure in-memory, no dependencies.
 * A "record" is one request that came from Claude Code (or one internal call the proxy made for it).
 */
const num = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : +process.env[k]);

// Prices per million tokens. The defaults reproduce this relay's own dashboard to the cent
// (verified on 7 rows): total_input*0.5 + cache_read*0.5 + cache_write*0.625 + output*2.5
const price = () => ({ inp: num('PRICE_IN', 0.5), out: num('PRICE_OUT', 2.5), cr: num('PRICE_CACHE_READ', 0.5), cw: num('PRICE_CACHE_WRITE', 0.625) });
function estimateCost(totalIn, out, cacheRead, cacheWrite) {
  const p = price();
  return ((totalIn || 0) * p.inp + (cacheRead || 0) * p.cr + (cacheWrite || 0) * p.cw + (out || 0) * p.out) / 1e6;
}

function createStats({ maxRecords = 400, maxSeries = 240, maxAlerts = 80 } = {}) {
  const started = Date.now();
  let seq = 0;
  const records = [];       // newest last
  const alerts = [];
  const active = new Map(); // id -> partial record (in flight)
  const t = {
    requests: 0, errors: 0, toolCalls: 0, serverToolCalls: 0, extraAsks: 0, retries: 0,
    inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ms: 0, trims: 0, compactions: 0,
    byKind: {}, byStatus: {}, tools: {}, models: {},
  };
  const series = [];

  const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

  function begin(info) {
    const id = ++seq;
    active.set(id, { id, ts: Date.now(), kind: 'agent', status: 'running', tools: [], notes: [], ...info });
    return id;
  }
  function note(id, text) { const r = active.get(id); if (r) { r.notes.push(String(text).slice(0, 300)); if (r.notes.length > 12) r.notes.shift(); } }
  function patch(id, p) { const r = active.get(id); if (r) Object.assign(r, p); }
  function tool(id, name, ok, summary, extra = {}) {
    const r = active.get(id); if (r) r.tools.push({ name, ok, summary: String(summary || '').slice(0, 160), ...extra });
    const s = t.tools[name] || (t.tools[name] = { calls: 0, ok: 0, fail: 0, proxy: 0 });
    s.calls++; if (ok) s.ok++; else s.fail++; if (extra.proxy) { s.proxy++; t.serverToolCalls++; }
    t.toolCalls++;
  }
  function end(id, p = {}) {
    const r = active.get(id); if (!r) return null; active.delete(id);
    Object.assign(r, p); r.ms = r.ms || Date.now() - r.ts; if (r.status === 'running') r.status = 'ok';
    const totalIn = r.inTok || 0;
    r.cost = estimateCost(totalIn, r.outTok, r.cacheRead, r.cacheWrite);
    records.push(r); if (records.length > maxRecords) records.shift();
    t.requests++; bump(t.byKind, r.kind); bump(t.byStatus, String(r.httpStatus || 200)); if (r.model) bump(t.models, r.model);
    if (r.status === 'error') t.errors++;
    t.inTok += totalIn; t.outTok += r.outTok || 0; t.cacheRead += r.cacheRead || 0; t.cacheWrite += r.cacheWrite || 0; t.cost += r.cost; t.ms += r.ms;
    t.extraAsks += r.extra || 0; t.retries += r.retries || 0;
    if (r.reqKB) { series.push({ t: r.ts, kb: Math.round(r.reqKB), tok: totalIn, kind: r.kind }); if (series.length > maxSeries) series.shift(); }
    return r;
  }
  function event(type, text, data = {}) {      // trims, compactions, fallbacks, 403/503 ... shown as alerts
    alerts.push({ ts: Date.now(), type, text: String(text).slice(0, 400), ...data }); if (alerts.length > maxAlerts) alerts.shift();
    if (type === 'trim') t.trims++; if (type === 'compaction') t.compactions++;
  }
  function snapshot(sinceId = 0) {
    const n = records.length;
    return {
      now: Date.now(), uptimeS: Math.round((Date.now() - started) / 1000),
      totals: { ...t, avgMs: t.requests ? Math.round(t.ms / t.requests) : 0, errorRate: t.requests ? t.errors / t.requests : 0 },
      active: [...active.values()].map(r => ({ id: r.id, ts: r.ts, kind: r.kind, model: r.model, reqKB: r.reqKB })),
      recent: records.slice(-60).reverse().filter(r => r.id > sinceId),
      series, alerts: alerts.slice(-30).reverse(), lastId: n ? records[n - 1].id : 0, price: price(),
    };
  }
  function reset() { records.length = 0; alerts.length = 0; series.length = 0; for (const k of Object.keys(t)) { if (typeof t[k] === 'number') t[k] = 0; else t[k] = {}; } }
  return { begin, note, patch, tool, end, event, snapshot, reset, estimateCost };
}

module.exports = { createStats, estimateCost };
