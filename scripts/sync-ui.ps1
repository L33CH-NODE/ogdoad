# Build Ogdoad's UI from core/ui and install it into the pinned runtime, which serves it.
# Until the whole core builds on Windows, Ogdoad runs the published Paperclip runtime pinned in
# runtime/package.json with our UI swapped in. Upstream's UI is kept beside it as ui-dist.upstream.
# Usage: pwsh scripts/sync-ui.ps1 [-SkipBuild]
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$core = Join-Path $repo 'core'
$serverPkg = Join-Path $repo 'runtime\node_modules\@paperclipai\server'
if (-not (Test-Path $serverPkg)) { throw "Runtime not installed. Run: cd `"$repo\runtime`"; npm install" }

if (-not $SkipBuild) {
  $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  # Paperclip's package scripts assume a POSIX shell; use Git Bash for them, for this build only.
  $env:npm_config_script_shell = 'C:\Program Files\Git\bin\bash.exe'
  Push-Location $core
  try { pnpm --filter "@paperclipai/ui..." build; if ($LASTEXITCODE) { throw "UI build failed ($LASTEXITCODE)" } }
  finally { Pop-Location }
}

$built = Join-Path $core 'ui\dist'
$target = Join-Path $serverPkg 'ui-dist'
$upstream = Join-Path $serverPkg 'ui-dist.upstream'
if (-not (Test-Path (Join-Path $built 'index.html'))) { throw "No UI build at $built" }
if (-not (Test-Path $upstream)) { Copy-Item $target $upstream -Recurse }   # keep upstream's UI once
robocopy $built $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }
Write-Host "Ogdoad UI installed into the runtime. Reload the browser tab to see it."
