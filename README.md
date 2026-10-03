# Claude Code Tool Proxy v2.1

Claude Code -> this proxy -> your provider. The provider only ever sees plain chat text;
tool calls are converted back into native `tool_use` events, so Bash/Read/Edit/Write/Grep/
Glob/TodoWrite/Task/plan-mode etc. all execute locally in Claude Code.

## Run (Windows)
    .\start.ps1                       # proxy + claude together
    .\start.ps1 -KeepMcp "mcp__unity" # also keep MCP tools starting with this prefix
    .\start.ps1 -DebugProxy           # verbose parse log
Manual: `node alias-proxy.js`, then in another terminal
`$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8082"; claude`
If the proxy console shows no `[→]` lines, Claude Code is bypassing it: check
`~/.claude/settings.json` -> `"env"` for an `ANTHROPIC_BASE_URL` that overrides the shell.
Change provider: `TARGET_URL=https://other.host node alias-proxy.js`.

## What v2.1 does
- Tool docs are generated from the real schemas Claude Code sends (any version), compactly
  (name, required params, types, enums, one-line description). The proxy logs the injection size.
- Tool-call format is raw `<param>` tags: no JSON escaping, so C# code, quotes and Windows
  backslashes pass through byte-exact. JSON calls are still accepted and auto-repaired.
- Malformed / unknown-tool calls are not shown to you: the proxy asks the model to re-send
  (up to 2 retries) and splices the corrected call into the same reply.
- Model "continues" after a call with a made-up result: text is cut and upstream aborted.
- Thinking blocks stream live with correct indexes; history drops old thinking (saves tokens).
- Fixed from v3.0: thinking/text block index collision, thinking never closed, UTF-8 split
  across chunks, empty text blocks, count_tokens triggering a real generation, `?beta=true`
  dropped, 64 KB tool-call cap (big Write), non-core tools (ExitPlanMode, Task, BashOutput...)
  dropped, images flattened to text, and start.ps1 crashing on read-only `$pid`.
- Esc / closing Claude Code cancels the upstream request. 429/502/503/504/529 retried.

## Honest limits
- It is prompt-based, so a model can still occasionally ignore the format; the repair + retry
  makes that rare and visible rather than silent, but it is not enforced by a server.
- Tool arguments arrive all at once (no progressive display of a long Write).
- Parallel calls are supported; results come back next turn as `<tool_result>` blocks.
- Run `npm test` after changes: 13 tests against a mock provider.
