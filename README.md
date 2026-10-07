# Claude Code proxy v3.0

Runs **Claude Code** through a relay (api.justwoker.icu) that strips Claude Code's tools. Zero npm dependencies, Node 18+.

```powershell
cd "C:\Users\Admin\Desktop\Universe Builder\claude-proxy-v3"
node probe.js            # optional, once: learns what YOUR relay supports -> capabilities.json
node alias-proxy.js      # start the proxy; leave this window open
# new window:
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8082"; claude
```
Dashboard: **http://127.0.0.1:8082/** (live requests, tool usage, request size, cost estimate, events).  Tests: `npm test`.

## What changed from v2.8
| Area | v3.0 |
|---|---|
| Native tools | `read` `write` `edit` `bash` (lowercase) are sent through the real function-calling channel, which this relay honors. The code-carrying tools therefore no longer pass through text tags. Everything else uses the hardened text bridge. Auto-detected, with automatic fallback (`NATIVE_TOOLS=0` forces text only). |
| Web | `WebSearch`, `WebFetch`, `fetch_image` are executed by the proxy (Claude Code's own versions need an Anthropic server tool the relay lacks). Private/LAN addresses are blocked, redirects re-checked. |
| Context cost | Auto-compaction: old history is replaced (upstream only) by a cached summary, recent messages stay verbatim. Triggers at 260 KB (`AUTO_COMPACT_KB`). Your own Claude Code history is untouched. |
| `/compact` | Never returns a fake summary: empty answer -> one retry -> an error, so your context is not wiped. History is shown to the model as prose, not call syntax. |
| Billing | `cache_control` is stripped: on this relay cached tokens are billed twice (verified to the cent on 7 dashboard rows: `total_in*0.5 + cache_read*0.5 + cache_write*0.625 + out*2.5` per M). Usage is reported to Claude Code in Anthropic form (the relay's `input_tokens` already includes cache). |
| 503s | Exponential backoff with jitter inside a 60 s budget; an unavailable model (e.g. Claude Code's haiku side requests) falls back to the main model and is remembered. |
| Dashboard | New. |
| Images | Images in tool results and prompts are passed to the model as real image blocks (`node probe.js` tells you whether your relay's model can see them). |

## Compared with ccproxy.py (the Python proxy)
Adopted from its design (own implementation; no code copied): native lowercase tools, proxy-run web tools, a dashboard, trimming of old output, count_tokens estimate.
Where v3 differs: raw-tag text bridge with a fuzz-tested parser (wrong closers, C# `<param>` doc comments), guards against "I'll do it" stops and invented edits, time-budgeted retries, streaming only as a one-request fallback (streamed calls were billed ~4.7x), auto-compaction with cached notes, no Python/Flask, SSRF-guarded fetch.
ccproxy still has: a ping every 3 s to Claude Code while it waits, a `usage_baseline_tokens` correction for the relay's hidden ~10k-token prompt, and a 70-test Python suite. v3 has 54 + 11 + probe tests.

## Search providers (first configured one that answers wins)
`BRAVE_API_KEY` · `TAVILY_API_KEY` · `SEARXNG_URL` (self-hosted, can include Google results) · `GOOGLE_API_KEY`+`GOOGLE_CSE_ID` (**Google's Custom Search JSON API is closed to new customers and ends 2027-01-01**, so it only works if you already have a key) · DuckDuckGo (no setup, always the last resort). Scraping google.com directly is not supported: it breaks Google's terms and is blocked. Order: `SEARCH_PROVIDERS=brave,tavily,searxng,google,duckduckgo`.

## Switches
`NATIVE_TOOLS=auto|1|0` · `AUTO_COMPACT=0` · `AUTO_COMPACT_KB=260` · `COMPACT_KEEP_KB=80` · `SERVER_TOOLS=0` · `TRIM_ABOVE_KB=300` · `KEEP_CACHE=1` · `UPSTREAM_MODEL=` (force one model) · `UP_RETRIES=6` `UP_BUDGET_S=60` · `PRICE_IN/OUT/CACHE_READ/CACHE_WRITE` (dashboard cost) · `WEB_ALLOW_PRIVATE=1` · `DROP_TOOLS=AskUserQuestion,EnterPlanMode` · `CALL_FORMAT=json`. Older v2.7/v2.8 switches still work (see git history of this README in the v2.8 zip).

## Honest limits
- Tested against mock providers only. Native mode, auto-compaction and the web tools have not been run against your real relay yet: the first session decides. If anything misbehaves: `NATIVE_TOOLS=0`, `AUTO_COMPACT=0`, `SERVER_TOOLS=0`.
- Not 100% native and no "99.9% no errors" promise is possible: the relay still adds a hidden ~10k-token prompt, thinking arrives all at once (non-streamed), summaries are lossy, and the model can still choose to stop early. The dashboard shows the real error rate.
- A proxy cannot make the relay accept tools it blocks; native mode works only for the names it passes (see `capabilities.json`).
- Compaction notes are written by the same model and can omit details: recent messages are verbatim and the model is told to re-read files instead of trusting memory.

## License note
ccproxy.py is PolyForm Noncommercial 1.0.0 (personal use is free; commercial use needs the author's licence). This proxy contains none of its code. If you ever build a commercial product, do not copy ccproxy's source into it.
