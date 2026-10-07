# Claude Code Tool Proxy v2.1 - Windows launcher
# Usage:  .\start.ps1            (proxy + claude)
#         .\start.ps1 -DebugProxy
#         .\start.ps1 -KeepMcp "mcp__unity"     (keep MCP tools with this prefix)
param(
    [int]$Port = 8082,
    [switch]$DebugProxy,
    [string]$KeepMcp = ""
)

$ProxyUrl  = "http://127.0.0.1:$Port"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  Claude Code Tool Proxy v2.1" -ForegroundColor Cyan

# Free the port if an old proxy is still running ($pid is read-only in PowerShell, so use $procId)
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    $procId = ($existing | Select-Object -First 1).OwningProcess
    Write-Host "  [!] Port $Port in use by PID $procId - stopping it" -ForegroundColor Yellow
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

# Env vars are inherited by the proxy process
$env:PORT = "$Port"
if ($DebugProxy) { $env:PROXY_DEBUG = "1" }
if ($KeepMcp)    { $env:KEEP_MCP = $KeepMcp }

$proxy = Start-Process -FilePath "node" -ArgumentList "alias-proxy.js" `
    -WorkingDirectory $ScriptDir -PassThru -WindowStyle Normal

$ready = $false
for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 300
    try {
        $r = Invoke-WebRequest -Uri "$ProxyUrl/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
}
if (-not $ready) {
    Write-Host "  [!] Proxy did not start - check the proxy window for errors" -ForegroundColor Red
    exit 1
}
Write-Host "  [+] Proxy running on $ProxyUrl (PID $($proxy.Id))" -ForegroundColor Green

$env:ANTHROPIC_BASE_URL = $ProxyUrl
Write-Host "  [*] Launching Claude Code (run /clear first in an old session)" -ForegroundColor Cyan
Write-Host ""
& claude @args

Write-Host ""
Write-Host "  [*] Claude Code exited - stopping proxy" -ForegroundColor Yellow
Stop-Process -Id $proxy.Id -Force -ErrorAction SilentlyContinue
