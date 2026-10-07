# Claude Code proxy v3.0

Runs **Claude Code** through a relay (api.justwoker.icu) that strips Claude Code's tools.  
Zero npm dependencies · Node 18+ required.

---

## Quick start

### Windows — recommended (`start.ps1`)

```powershell
cd "C:\Users\Admin\Desktop\Universe Builder\claude-proxy-v3"

# First time only: learn what your relay supports
node probe.js

# Start proxy + Claude Code in one step
.\start.ps1
```

`start.ps1` automatically:
- Kills anything already on port 8082
- Starts the proxy in a separate window
- Waits until `/health` responds
- Sets `ANTHROPIC_BASE_URL` and launches Claude Code
- Shuts the proxy down when Claude Code exits

**Optional flags:**

```powershell
.\start.ps1 -Port 9000            # use a different port
.\start.ps1 -DebugProxy           # verbose proxy logging (sets PROXY_DEBUG=1)
.\start.ps1 -KeepMcp "mcp__unity" # keep MCP tools whose name starts with this prefix
```

---

### Windows — manual (two terminals)

```powershell
# Terminal 1 — proxy
cd "C:\Users\Admin\Desktop\Universe Builder\claude-proxy-v3"
node alias-proxy.js

# Terminal 2 — Claude Code
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8082"
claude
```

---

### Linux / macOS (`start.sh`)

```bash
cd /path/to/claude-proxy-v3
chmod +x start.sh

# First time only
node probe.js

# Start everything
./start.sh

# Pass extra args straight to Claude Code
./start.sh --dangerously-skip-permissions
```

Custom port:

```bash
PORT=9000 ./start.sh
```

---

### Manual — Linux / macOS

```bash
# Terminal 1
node alias-proxy.js

# Terminal 2
export ANTHROPIC_BASE_URL="http://127.0.0.1:8082"
claude
```

---

## Dashboard

Open **http://127.0.0.1:8082/** in any browser while the proxy is running.

| Panel | What it shows |
|---|---|
| Live requests | Every request in/out, latency, model used |
| Tool usage | Which tools fired, success/failure counts |
| Request size | Prompt size per call (KB) |
| Cost estimate | Running spend based on `PRICE_*` env vars |
| Events log | Retries, compaction triggers, fallbacks, errors |

The dashboard updates in real time (Server-Sent Events). No refresh needed.

---

## Web search — API keys & setup

The proxy runs `WebSearch` / `WebFetch` / `fetch_image` itself (the relay lacks Anthropic's server tools).  
Set **one or more** of the keys below. The first configured provider that returns results wins.

### Priority order

```
SEARCH_PROVIDERS=brave,tavily,searxng,google,duckduckgo   ← default order
```

Override order any time by setting that env var with a comma-separated list.

---

### 1. Brave Search *(recommended — best results, free tier)*

1. Go to **https://api.search.brave.com/**
2. Sign up → **API Keys** → create a key (Free plan: 2 000 queries/month)
3. Set the key:

```powershell
# Windows — add to your PowerShell profile or set before start.ps1
$env:BRAVE_API_KEY = "BSAxxxxxxxxxxxxxxxxxx"
.\start.ps1
```

```bash
# Linux/macOS
BRAVE_API_KEY="BSAxxxxxxxxxxxxxxxxxx" ./start.sh
```

---

### 2. Tavily *(great for AI-focused search)*

1. Go to **https://tavily.com/** → sign up → **API Keys**
2. Copy your key

```powershell
$env:TAVILY_API_KEY = "tvly-xxxxxxxxxxxxxxxx"
.\start.ps1
```

```bash
TAVILY_API_KEY="tvly-xxxxxxxxxxxxxxxx" ./start.sh
```

---

### 3. SearXNG *(self-hosted, free, can include Google results)*

Run your own SearXNG instance (Docker is the easiest):

```bash
docker run -d -p 8080:8080 searxng/searxng
```

Then point the proxy at it:

```powershell
$env:SEARXNG_URL = "http://localhost:8080"
.\start.ps1
```

```bash
SEARXNG_URL="http://localhost:8080" ./start.sh
```

---

### 4. Google Custom Search *(existing keys only)*

> **Note:** Google's Custom Search JSON API is **closed to new customers** and **ends 2027-01-01**. Only use this if you already have a key.

```powershell
$env:GOOGLE_API_KEY  = "AIzaxxxxxxxxxxxxxxxx"
$env:GOOGLE_CSE_ID   = "xxxxxxxxxxxxxxxxx"
.\start.ps1
```

```bash
GOOGLE_API_KEY="AIzaxxxxxxxxxxxxxxxx" GOOGLE_CSE_ID="xxxxxxxxxxxxxxxxx" ./start.sh
```

---

### 5. DuckDuckGo *(no key — always available as last resort)*

Requires no setup. Always tried last. No rate limit guarantee.

---

### Setting multiple keys at once (Windows example)

```powershell
$env:BRAVE_API_KEY   = "BSAxxxxxxxxxxxxxxxxxx"
$env:TAVILY_API_KEY  = "tvly-xxxxxxxxxxxxxxxx"
$env:SEARXNG_URL     = "http://localhost:8080"
$env:SEARCH_PROVIDERS = "brave,tavily,searxng,duckduckgo"
.\start.ps1
```

---

## All switches (environment variables)

Set any of these before running `start.ps1` / `start.sh` / `node alias-proxy.js`.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8082` | Port the proxy listens on |
| `NATIVE_TOOLS` | `auto` | `auto` = detect from capabilities.json · `1` = always native · `0` = text-bridge only |
| `AUTO_COMPACT` | `1` | `0` = disable auto-compaction |
| `AUTO_COMPACT_KB` | `260` | Trigger compaction when upstream context exceeds this size (KB) |
| `COMPACT_KEEP_KB` | `80` | Keep this many KB of the most recent messages verbatim after compaction |
| `SERVER_TOOLS` | `1` (on) | The proxy runs `WebSearch`, `WebFetch`, and `fetch_image` itself (your relay lacks Anthropic's server tools). `0` = disable proxy-side web tools |
| `TRIM_ABOVE_KB` | `300` | Trim old tool output when a single message exceeds this size (KB) |
| `KEEP_CACHE` | `1` | `0` = strip `cache_control` blocks (saves tokens if your relay double-bills cache) |
| `UPSTREAM_MODEL` | *(relay default)* | Force a specific model name for every upstream call |
| `UP_RETRIES` | `6` | Max retries per request within the time budget |
| `UP_BUDGET_S` | `60` | Total seconds allowed for retries (exponential backoff with jitter) |
| `PROXY_DEBUG` | `0` | `1` = verbose request/response logging |
| `WEB_ALLOW_PRIVATE` | `0` | `1` = allow WebFetch to reach private/LAN addresses (disabled by default for SSRF safety) |
| `DROP_TOOLS` | *(none)* | Comma-separated tool names to remove from every request, e.g. `AskUserQuestion,EnterPlanMode` |
| `CALL_FORMAT` | `auto` | `json` = always use JSON tool call format |
| `SEARCH_PROVIDERS` | `brave,tavily,searxng,google,duckduckgo` | Search provider priority order |
| `BRAVE_API_KEY` | *(none)* | Brave Search API key |
| `TAVILY_API_KEY` | *(none)* | Tavily API key |
| `SEARXNG_URL` | *(none)* | SearXNG instance URL |
| `GOOGLE_API_KEY` | *(none)* | Google Custom Search API key |
| `GOOGLE_CSE_ID` | *(none)* | Google Custom Search engine ID |
| `PRICE_IN` | relay default | Cost per million input tokens (for dashboard cost estimate) |
| `PRICE_OUT` | relay default | Cost per million output tokens |
| `PRICE_CACHE_READ` | relay default | Cost per million cache-read tokens |
| `PRICE_CACHE_WRITE` | relay default | Cost per million cache-write tokens |

---

## What changed from v2.8

| Area | v3.0 |
|---|---|
| Native tools | `read` `write` `edit` `bash` (lowercase) are sent through the real function-calling channel, which this relay honors. Everything else uses the hardened text bridge. Auto-detected, with automatic fallback (`NATIVE_TOOLS=0` forces text only). |
| Web | `WebSearch`, `WebFetch`, `fetch_image` are executed by the proxy (Claude Code's own versions need an Anthropic server tool the relay lacks). Private/LAN addresses are blocked, redirects re-checked. |
| Context cost | Auto-compaction: old history is replaced (upstream only) by a cached summary, recent messages stay verbatim. Triggers at 260 KB (`AUTO_COMPACT_KB`). Your own Claude Code history is untouched. |
| `/compact` | Never returns a fake summary: empty answer → one retry → an error, so your context is not wiped. History is shown to the model as prose, not call syntax. |
| Billing | `cache_control` is stripped: on this relay cached tokens are billed twice (verified to the cent on 7 dashboard rows: `total_in*0.5 + cache_read*0.5 + cache_write*0.625 + out*2.5` per M). Usage is reported to Claude Code in Anthropic form. |
| 503s | Exponential backoff with jitter inside a 60 s budget; an unavailable model (e.g. Claude Code's haiku side requests) falls back to the main model and is remembered. |
| Dashboard | New — live requests, tool usage, cost, events. |
| Images | Images in tool results and prompts are passed as real image blocks (`node probe.js` tells you whether your relay's model can see them). |

---

## Honest limits

- Tested against mock providers only. Native mode, auto-compaction and the web tools have not been run against your real relay yet: the first session decides. If anything misbehaves: `NATIVE_TOOLS=0`, `AUTO_COMPACT=0`, `SERVER_TOOLS=0`.
- The relay still adds a hidden ~10k-token prompt, thinking arrives all at once (non-streamed), summaries are lossy, and the model can still choose to stop early. The dashboard shows the real error rate.
- A proxy cannot make the relay accept tools it blocks; native mode works only for the names it passes (see `capabilities.json`).
- Compaction notes are written by the same model and can omit details: recent messages are verbatim and the model is told to re-read files instead of trusting memory.

---

## Tests

```powershell
npm test          # runs selftest + libtest + probetest
node probe.js     # run once after install to update capabilities.json
```
