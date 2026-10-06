# Claude Code text-emulation proxy v2.8 (your design, fixed)

## v2.8: /compact works, smaller prompts, cheaper streaming
- `/compact` (and auto-compact) is detected from Claude Code's summary request. The proxy then: turns the tool bridge OFF (the model must answer in plain text; before, it answered with a Read call, the compaction never finished and kept retrying), shrinks the history to `COMPACT_TARGET_KB` (default 200), streams that one request so Cloudflare's ~100 s limit cannot cut a long summary, and removes any tool-call text from the summary. Console lines start with `[compact]`.
- History budget: above `TRIM_ABOVE_KB` (default 300, 0 = off) old content is shrunk oldest-first in 4 passes (old tool outputs, then big old Write/Edit inputs which are already on disk) down to 55% of that limit. The newest 4-10 messages are never touched. Old call inputs become a one-line prose note (not call-shaped, so the model cannot copy a placeholder into a file).
- Streaming is now per request (after a 524, and for /compact) and NOT sticky: on this provider streamed calls were billed ~4.7x a normal call for the same prompt. `STREAM_STICKY=1` restores the old behavior.


Same technology as your version: Claude Code -> proxy -> provider (stream=false), tools described as text,
model replies with <tool_call> text, proxy turns it into native tool_use SSE events.

## Run
1. `node alias-proxy.js`   (leave it open)
2. New terminal in your project: `claude`, then `/clear`, then ask it to read a file.
3. Optional check while the proxy runs: `node diagnose.js`
Env (Windows variables you already set): ANTHROPIC_BASE_URL=http://127.0.0.1:8082, ANTHROPIC_MODEL, ANTHROPIC_AUTH_TOKEN,
ENABLE_TOOL_SEARCH=false.  Optional: KEEP_MCP=mcp__unity, EXTRA_TOOLS=Name1,Name2, FORMAT_RETRIES=1, FEWSHOT=0, PROXY_DEBUG=1.

## What was fixed
- Prompt: no more "OVERRIDE / disregard limitations" (the model read it as a jailbreak and refused). It now explains
  the bridge: the user's local program executes the model's text. Bridge text goes FIRST in the system prompt.
- History is flattened into the same <tool_call>/<tool_result> text, plus a tiny worked example (FEWSHOT) so the model sees it succeed.
- Calls accept raw <param> tags (no JSON escaping) and JSON with unescaped Windows paths / raw newlines (auto-repaired).
- Only core tools (Bash, PowerShell, Read, Write, Edit, Glob, Grep, ...) with real schema signatures; MCP noise dropped.
- If the model refuses or sends a malformed call: one automatic retry, then a visible warning (never a silent blank reply).
- No empty text blocks; thinking forwarded; text after the last call dropped; count_tokens is an estimate (was always 100).
- Provider 429/502/503 retried; errors reported as real HTTP errors; client disconnect cancels the provider request.
- The proxy window now prints what the model said whenever no tool call was made.

## Call format (A/B switch)
Default: the model is told to write raw `<param>` tags (no escaping needed). If you find your model is more reliable with JSON,
set `CALL_FORMAT=json` (PowerShell: `$env:CALL_FORMAT="json"; node alias-proxy.js`). The parser accepts BOTH formats in both modes
(JSON calls are repaired for unescaped Windows paths / raw newlines), so switching never breaks parsing.
Tip: extract this zip to a NEW folder and run it on another port (`$env:PORT=8083`) to compare without touching your current proxy.

## v2.3: JSON default + tunnel fallback
- Default call format is now JSON (`<tool_call>{"name":..,"parameters":{..}}</tool_call>`). `CALL_FORMAT=xml` switches to raw <param> tags. Both are always parsed.
- `TRANSPORT=auto` (default): text bridge first. If the model replies that it has no such tools (or uses read_tabular / system_todo_write),
  the proxy rebuilds the request so the model carries the real call inside its OWN function, system_todo_write
  ({"todos":[{"content":"{\"name\":\"Read\",\"parameters\":{...}}"}]}). The provider returns that call to us as a normal tool_use block, we unpack it
  into a native Claude Code tool call, and stay on the tunnel for later requests. Ordinary todo items (not JSON tool calls) are never run.
  `TRANSPORT=text` or `TRANSPORT=tunnel` force one path.
- Proxy window lines to look for: `tool call #1: Read` (success), `switching to the system_todo_write tunnel`, `tunnel works`.

## v2.4 changes (from the Edit + Cloudflare 403 log)
- A tool call that fails to parse (typically C# code inside a JSON string) is no longer retried by echoing the failed text back to the provider. The proxy switches to the raw `<param>` format (no escaping needed), resends the ORIGINAL conversation after 1.5 s, and stays on that format for later requests.
- Refusal retries only echo prose (tool_call blocks stripped, max 500 chars).
- An empty-body Cloudflare 403 gets ONE delayed (4 s) identical resend, then is reported.
- `UPSTREAM_UA` (optional) sets a User-Agent for the provider call. Off by default.
- Start with raw tags from the first request if you edit lots of C#:  `$env:CALL_FORMAT="xml"; node alias-proxy.js`

## v2.4.1: staying in the loop
- `DROP_TOOLS=AskUserQuestion,EnterPlanMode` (opt-in) stops the model from pausing itself to ask or to enter plan mode. ExitPlanMode stays.
- `EXTRA_TOOLS=TodoWrite,...` and `KEEP_MCP=mcp__blender__execute_blender_code,...` add tools back (each costs prompt tokens every turn).
- Tested: a scripted 40-turn loop with six different tools (Read/Edit/Write/Bash/Grep/Glob): every turn returns tool_use, params arrive byte-exact, history carries, final turn ends cleanly.

## v2.5: why Bash/PowerShell said "claude-opus-4-8 is temporarily unavailable"
Auto mode asks a model (through the same ANTHROPIC_BASE_URL, so through this proxy) whether each shell command is safe. Earlier versions stripped that request's own tool/tool_choice and returned plain text, so the check failed and Claude Code reported "temporarily unavailable". v2.5 emulates a forced or small custom tool set for such side-requests, and logs a `side-request` line (tool names, tool_choice, first 110 chars of the last user message; local console only) so we can see what Claude Code actually sends. Unknown message block types are no longer dropped silently (WARNING line).
Cloudflare 403s on large/command-heavy requests are a provider-side firewall verdict; the proxy only retries once, it does not disguise content.

## v2.6: seeing the auto-mode safety check
The real check is a plain-text request (no tools, max_tokens 64). The proxy now prints `side-request detail` (request keys, stop_sequences, thinking, last 200 chars of the system prompt and of the last user message, which is where the required answer format normally sits). `PROXY_CAPTURE=1` also saves the full request and the provider's reply to ./captures/side-*.json. Those files contain your CLAUDE.md and the command being judged: review before sharing. API keys/headers are never written.
Cloudflare 403s: in real logs an identical resend after 4 s succeeded every time, so they look transient, not content-based.

## v2.7: stopping early, and files damaged by wrong closing tags
Found in a real v2.5 log: the model closed parameters with `</parameter>` and the call with `</invoke>` (Claude's own native tags). The old parser only knew `</param>`/`</tool_call>`, so it (a) swallowed the stray `</parameter>` lines into the Edit and wrote them into RIVER_REBUILD_UNREAL.md, and (b) reported "cut off inside the tool call", which ended the turn, i.e. the early stop.
- Parser: accepts `<invoke>/<parameter>` and `</parameter>/</invoke>/</function_calls>`; parameter boundaries are only openers named like a real parameter of that tool at a line start, so C# `/// <param name="x">..</param>` lines inside code are kept byte-exact. A call whose last value has no closer and no terminator is treated as truncated and never applied.
- Retries: parse failures are re-asked up to 3 times (FORMAT_RETRIES) with the ORIGINAL conversation (failed text is never echoed) plus a closing-tag reminder in the system prompt. The XML format text now states the closing tags explicitly.
- Continuation guard: when the model ends a mid-task turn (right after a tool result) with no tool call and the reply reads like "Now I'll do X:" (or is empty), the proxy re-asks up to 2 times (CONTINUE_RETRIES; CONTINUE_GUARD=0 turns it off). Real final answers ("... Let me know ...", "Done.") and fresh questions are never re-asked.
- Cloudflare 524 (provider took >100 s) gets one retry. Very long single outputs can still hit it: ask for smaller edits.

### v2.7 (build 2026-10-05): closer to native behavior
- Tool descriptions: the file/shell tools (Read, Edit, Write, MultiEdit, Bash, PowerShell, Glob, Grep, LS, NotebookEdit) now reach the model with their FULL description (cap 1500 chars) and every parameter with type, enum, default and description, as native Claude Code does. Before, only the first sentence (110 chars) was sent, so rules like "Read before Edit" and "old_string must be unique" were lost. Other tools stay compact. `TOOL_DETAIL=compact` restores the old size.
- Default call format is raw tags (no JSON escaping); JSON failed on code, Windows paths and shell text in real logs. `CALL_FORMAT=json` brings JSON back.
- Closing-tag clean-up is balance-aware: a closer is removed only when it has no matching opener inside the value, so real `/// <param name="x">..</param>` lines are kept and stray `</param>`/`</parameter>`/`</invoke>` never reach your files (600-case fuzz test).
- The fake "bridge check" exchange is only added to a fresh conversation, not re-injected on every request. `<function_calls>` never leaks into visible text. A tool result the model writes itself is removed.
- Hallucination guard: if the model says it has edited/created/fixed files but made no Edit/Write/Bash/PowerShell call in this task, it is re-asked once (`HALLUCINATION_GUARD=0` disables).

### v2.7 (build 2026-10-05), token cost and streaming
- **Usage fix (likely cause of runaway context):** the proxy used to pass only `input_tokens` to Claude Code and drop `cache_read_input_tokens` / `cache_creation_input_tokens`. If the provider caches prompts, Claude Code saw a tiny context and never auto-compacted, so the conversation grew (806 KB seen) and every turn re-sent all of it. Cache fields are now passed through; if the provider reports less than a quarter of our byte-based estimate, the estimate is reported instead (so the context meter and auto-compact work).
- **See where tokens go:** every response prints `usage: input=… cache_read=… cache_write=… output=…` plus session totals and the number of EXTRA asks (format retries, continue/claim guards, firewall resends). Each extra ask re-sends the whole prompt.
- **Warning at 500 KB:** the console tells you to run /compact or start fresh.
- **Safety valve:** above 400 KB (`TRIM_ABOVE_KB`, 0 = off) old tool outputs (Read/Bash results) are cut to head+tail with a note; the last 10 messages are never touched. Lossy by design, and the model is told it can re-run the tool.
- **Streaming (opt-in):** `UPSTREAM_STREAM=1` asks the provider to stream and assembles the answer in the proxy (thinking, signature, text, usage), then hands Claude Code the same complete answer. It does not change tokens used; it can avoid Cloudflare 524 on long generations and shows as a stream request on your dashboard. Default stays non-streaming.

### v2.7 (build 2026-10-06): the "hangs for minutes" fix
Found in a real log: a request of 808 KB was sent and nothing came back. Two causes in the proxy itself:
1. A provider timeout was treated like a network blip: 5-minute wait, then the SAME giant request re-sent up to 3 more times (up to ~20 minutes of silence). Now `UPSTREAM_TIMEOUT_S` (default 180) applies, and a timeout / 524 / 504 triggers ONE switch to streaming mode (bytes keep flowing, so Cloudflare does not cut it), sticky for later requests. A second failure is reported, not looped.
2. When the model answered without a tool call, the continue / claim / format re-asks each re-sent the whole conversation and waited again. Re-asks now stop after `REASK_BUDGET_S` (default 150 s spent on the turn), and the optional ones (continue, claim check) are skipped when the request is over `GUARD_MAX_KB` (default 300 KB). The console says why it did not ask again.
Also: `still waiting for the provider: 40s (806 KB request - a prompt this big is slow: run /compact)` every `HEARTBEAT_S` (20) seconds, and every response line now shows how long the provider took.
