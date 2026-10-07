'use strict';
/**
 * Server-side web tools. Claude Code's WebSearch / WebFetch need an Anthropic server tool that this relay does not have,
 * so the proxy runs them itself when the model asks.
 *
 * Search providers (first configured one that answers wins; DuckDuckGo needs no setup and is always the last resort):
 *   brave     BRAVE_API_KEY                        https://brave.com/search/api/
 *   tavily    TAVILY_API_KEY                       https://tavily.com
 *   searxng   SEARXNG_URL (e.g. http://localhost:8888)   self-hosted meta search (can include Google results)
 *   google    GOOGLE_API_KEY + GOOGLE_CSE_ID       Custom Search JSON API: CLOSED TO NEW CUSTOMERS, ends 2027-01-01
 *   duckduckgo  (none)
 * Order: SEARCH_PROVIDERS=brave,tavily,searxng,google,duckduckgo
 */
const dns = require('node:dns').promises;
const net = require('node:net');

const num = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : +process.env[k]);
const UA = 'Mozilla/5.0 (compatible; ClaudeCodeProxy/3.0; +local)';
const deps = { fetch: (...a) => fetch(...a), lookup: host => dns.lookup(host, { all: true }) };   // replaceable in tests

// ------------------------------------------------------------------ safety: never let the model reach your own machine / LAN
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) { const x = ip.toLowerCase(); return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:127.') || x.startsWith('::ffff:10.') || x.startsWith('::ffff:192.168.'); }
  return true;
}
async function assertPublicUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw new Error(`not a valid URL: ${String(raw).slice(0, 80)}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`only http/https URLs are allowed (got ${u.protocol})`);
  if (process.env.WEB_ALLOW_PRIVATE === '1') return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error(`blocked: ${host} is a local address (set WEB_ALLOW_PRIVATE=1 to allow)`);
  const ips = net.isIP(host) ? [{ address: host }] : await deps.lookup(host);
  for (const r of ips) if (isPrivateIp(r.address)) throw new Error(`blocked: ${host} resolves to a private address ${r.address} (set WEB_ALLOW_PRIVATE=1 to allow)`);
  return u;
}

async function guardedFetch(url, init = {}, maxHops = 5) {   // follows redirects by hand so every hop is checked
  let cur = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    await assertPublicUrl(cur);
    const r = await deps.fetch(cur, { ...init, redirect: 'manual', signal: AbortSignal.timeout(num('WEB_TIMEOUT_S', 25) * 1000) });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { cur = new URL(r.headers.get('location'), cur).toString(); continue; }
    return { res: r, url: cur };
  }
  throw new Error('too many redirects');
}
async function readLimited(res, maxBytes) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) { const b = Buffer.from(await res.arrayBuffer()); return b.subarray(0, maxBytes); }
  const parts = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(Buffer.from(value)); n += value.length; if (n >= maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } break; } }
  return Buffer.concat(parts).subarray(0, maxBytes);
}

// ------------------------------------------------------------------ html -> text
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '...', copy: '(c)', laquo: '<<', raquo: '>>' };
const decodeEntities = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { try { return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)); } catch { return m; } }
  return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m;
});
function htmlToText(html) {
  let s = String(html);
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s) || [])[1];
  s = s.replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => { const t = inner.replace(/<[^>]+>/g, '').trim(); return t && /^https?:/i.test(href) ? `${t} (${href})` : t; });
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|pre|blockquote|table)>/gi, '\n').replace(/<(br|hr)\s*\/?>/gi, '\n').replace(/<li\b[^>]*>/gi, '- ');
  s = decodeEntities(s.replace(/<[^>]+>/g, ' '));
  s = s.replace(/[ \t\r\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return (title ? `# ${decodeEntities(title).replace(/\s+/g, ' ').trim()}\n\n` : '') + s;
}

// ------------------------------------------------------------------ search providers
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
async function jsonGet(url, headers) {
  const r = await deps.fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(num('WEB_TIMEOUT_S', 25) * 1000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json();
}
const PROVIDERS = {
  brave: {
    ready: () => !!process.env.BRAVE_API_KEY,
    run: async (q, n) => { const d = await jsonGet(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`, { 'x-subscription-token': process.env.BRAVE_API_KEY }); return ((d.web && d.web.results) || []).map(x => ({ title: x.title, url: x.url, snippet: x.description })); },
  },
  tavily: {
    ready: () => !!process.env.TAVILY_API_KEY,
    run: async (q, n) => { const r = await deps.fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.TAVILY_API_KEY}` }, body: JSON.stringify({ query: q, max_results: n, search_depth: 'basic' }), signal: AbortSignal.timeout(num('WEB_TIMEOUT_S', 25) * 1000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); const d = await r.json(); return (d.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.content })); },
  },
  searxng: {
    ready: () => !!process.env.SEARXNG_URL,
    run: async (q, n) => { const d = await jsonGet(`${process.env.SEARXNG_URL.replace(/\/$/, '')}/search?q=${encodeURIComponent(q)}&format=json`); return (d.results || []).slice(0, n).map(x => ({ title: x.title, url: x.url, snippet: x.content })); },
  },
  google: {   // legacy: only works for accounts that already had the Custom Search JSON API (closed to new customers, ends 2027-01-01)
    ready: () => !!(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID),
    run: async (q, n) => { const d = await jsonGet(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(process.env.GOOGLE_API_KEY)}&cx=${encodeURIComponent(process.env.GOOGLE_CSE_ID)}&q=${encodeURIComponent(q)}&num=${Math.min(n, 10)}`); return (d.items || []).map(x => ({ title: x.title, url: x.link, snippet: x.snippet })); },
  },
  duckduckgo: {
    ready: () => true,
    run: async (q, n) => {
      const r = await deps.fetch('https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded', 'accept-language': 'en-US,en;q=0.9' }, body: new URLSearchParams({ q, kl: 'wt-wt' }).toString(), signal: AbortSignal.timeout(num('WEB_TIMEOUT_S', 25) * 1000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); const html = await r.text(); const out = [];
      const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi;
      let m; while ((m = re.exec(html)) && out.length < n) {
        let url = decodeEntities(m[1]); const u = /[?&]uddg=([^&]+)/.exec(url); if (u) url = decodeURIComponent(u[1]); if (url.startsWith('//')) url = 'https:' + url;
        out.push({ title: decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim(), url, snippet: decodeEntities(String(m[3] || m[4] || '').replace(/<[^>]+>/g, '')).trim() });
      }
      return out;
    },
  },
};
const order = () => (process.env.SEARCH_PROVIDERS || 'brave,tavily,searxng,google,duckduckgo').split(',').map(s => s.trim()).filter(s => PROVIDERS[s]);
const configured = () => order().filter(p => PROVIDERS[p].ready());

const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const matches = (u, list) => { const h = hostOf(u); return list.some(d => h === d.replace(/^www\./, '') || h.endsWith('.' + d.replace(/^www\./, ''))); };

async function webSearch(input) {
  const q = String((input && input.query) || '').trim(); if (!q) return { text: '[web search: empty query]', ok: false };
  const n = num('WEB_SEARCH_RESULTS', 8), allowed = (input.allowed_domains || []).filter(Boolean), blocked = (input.blocked_domains || []).filter(Boolean);
  const errs = []; const t0 = Date.now();
  for (const name of configured()) {
    try {
      let res = await PROVIDERS[name].run(q, n * 2);
      if (allowed.length) res = res.filter(r => matches(r.url, allowed)); if (blocked.length) res = res.filter(r => !matches(r.url, blocked));
      res = res.filter(r => r.url).slice(0, n);
      if (res.length) return { ok: true, provider: name, ms: Date.now() - t0, count: res.length, text: `Web search results for "${q}" (via ${name}):\n\n` + res.map((r, i) => `${i + 1}. ${clip(r.title, 140)}\n   ${r.url}\n   ${clip(r.snippet, 300)}`).join('\n\n') + '\n\nUse WebFetch on a URL above to read the full page.' };
      errs.push(`${name}: no results`);
    } catch (e) { errs.push(`${name}: ${e.message}`); }
  }
  return { ok: false, ms: Date.now() - t0, text: `[web search failed for "${q}": ${errs.join('; ') || 'no provider configured'}]` };
}

async function webFetch(input) {
  const url = String((input && input.url) || '').trim(); if (!url) return { text: '[web fetch: empty url]', ok: false };
  const max = num('WEB_FETCH_MAX_CHARS', 20000), t0 = Date.now();
  try {
    const { res, url: finalUrl } = await guardedFetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.8' } });
    if (res.status >= 400) return { ok: false, ms: Date.now() - t0, text: `[web fetch: HTTP ${res.status} for ${finalUrl}]` };
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (/^(image|video|audio)\//.test(ct) || /pdf|zip|octet-stream/.test(ct)) return { ok: false, ms: Date.now() - t0, text: `[web fetch: ${finalUrl} is ${ct}, not readable text${ct.startsWith('image/') ? ' (use fetch_image to look at it)' : ''}]` };
    const buf = await readLimited(res, num('WEB_FETCH_MAX_BYTES', 2 * 1024 * 1024)); let text = buf.toString('utf8');
    text = /html|xml/.test(ct) || /^\s*<(!doctype|html)/i.test(text) ? htmlToText(text) : text;
    const cut = text.length > max; if (cut) text = text.slice(0, max);
    const ask = input.prompt ? `\n\n(The user's question about this page: ${clip(input.prompt, 500)})` : '';
    return { ok: true, ms: Date.now() - t0, chars: text.length, text: `Content of ${finalUrl}:\n\n${text}${cut ? `\n\n[... truncated at ${max} characters]` : ''}${ask}` };
  } catch (e) { return { ok: false, ms: Date.now() - t0, text: `[web fetch failed for ${url}: ${e.message}]` }; }
}

async function fetchImage(input) {
  const url = String((input && input.url) || '').trim(); if (!url) return { text: '[fetch_image: empty url]', ok: false };
  try {
    const { res, url: finalUrl } = await guardedFetch(url, { headers: { 'user-agent': UA, accept: 'image/*,*/*;q=0.8' } });
    if (res.status >= 400) return { ok: false, text: `[fetch_image: HTTP ${res.status}]` };
    let ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
    if (!ext[ct] && !Object.values(ext).includes(ct)) { const e = Object.keys(ext).find(x => finalUrl.toLowerCase().split('?')[0].endsWith(x)); if (e) ct = ext[e]; }
    if (!Object.values(ext).includes(ct)) return { ok: false, text: `[fetch_image: unsupported type ${ct || 'unknown'}]` };
    const buf = await readLimited(res, num('WEB_IMAGE_MAX_BYTES', 3.5 * 1024 * 1024));
    return { ok: true, text: `Image from ${finalUrl} (${Math.round(buf.length / 1024)} KB):`, image: { type: 'image', source: { type: 'base64', media_type: ct, data: buf.toString('base64') } } };
  } catch (e) { return { ok: false, text: `[fetch_image failed: ${e.message}]` }; }
}

const SERVER_TOOL_NAMES = new Set(['WebSearch', 'WebFetch', 'fetch_image']);
async function runServerTool(name, input) {
  if (name === 'WebSearch') return webSearch(input || {});
  if (name === 'WebFetch') return webFetch(input || {});
  if (name === 'fetch_image') return fetchImage(input || {});
  return { ok: false, text: `[unknown server tool ${name}]` };
}

module.exports = { webSearch, webFetch, fetchImage, runServerTool, SERVER_TOOL_NAMES, configured, order, htmlToText, assertPublicUrl, isPrivateIp, deps, PROVIDERS };
