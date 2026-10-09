#!/usr/bin/env pwsh
<#
.SYNOPSIS
    End-to-end verification for dsh-session-importer against a throwaway DSH instance.

.DESCRIPTION
    Boots a scratch `dsh web` and exercises the whole import path over HTTP:
    the client bundle, the plugin fiber, the import route (host path and raw
    body upload), idempotency, partial-import repair, and both refusal paths
    (not a ZIP, unknown event vocabulary with rollback). With a Chromium-family
    browser available it then drives the real Web GUI headless to verify the
    item this plugin injects into the Session header's more-actions menu. Nothing
    is written to the real DSH home.

    How the scratch instance is built:

      <repo>/.verify-home/                scratch DSH_HOME (removed at the end)
        profiles/web/                     copy of the real profile's small files
          node_modules -> <real profile>/node_modules   (junction/symlink, read-only use)
        sessions/ attachments/ storages/  scratch state
        importer-overlay.yml              mounts this package by absolute path

    Booting a profile does not run a package install, so a junctioned
    node_modules is enough and no network access is needed. The overlay mounts
    the plugin by absolute source path, so nothing has to be installed into a
    profile first.

.PARAMETER Archive
    Session-log ZIP to import. Defaults to the `dsh-session-*.zip` sample in the
    repository root.

.PARAMETER ProfileName
    Profile to clone and boot. Defaults to `web`.

.PARAMETER Port
    Listen port for the scratch instance; 0 lets the OS pick a free one.

.PARAMETER DshHome
    Real DSH home to clone the profile from. Defaults to $env:DSH_HOME, then ~/.dsh.

.PARAMETER ThemeHome
    DSH home to copy theme state from. Defaults to the same home as DshHome. The
    scratch instance is meant to render exactly like the deployment, so the
    active skin, material preset, and wallpaper are carried over; a UI check
    that only ever sees plugin defaults cannot catch a theming bug.

.PARAMETER BootTimeoutSeconds
    How long to wait for the scratch instance to print its URL.

.PARAMETER KeepScratch
    Keep the scratch home and its logs after the run (for debugging).

.PARAMETER SkipUi
    Skip the headless-browser leg. That leg verifies the import item injected
    into the Session header's more-actions menu (it lives in another plugin's
    DOM, so it can only be checked against the real rendered markup).

.PARAMETER ProbeUi
    Run the headless-browser leg in diagnostic mode: dump the rendered shell
    (menus, menu anchors, dialogs, sidebar rows) instead of asserting. Use this
    when a DSH release changes the markup that another plugin owns.

.EXAMPLE
    pwsh -NoProfile -File scripts/verify-e2e.ps1

.EXAMPLE
    pwsh -NoProfile -File scripts/verify-e2e.ps1 -Archive D:/backup/dsh-session-x.zip -KeepScratch
#>
[CmdletBinding()]
param(
    [string]$Archive,
    [string]$ProfileName = 'web',
    [int]$Port = 0,
    [string]$DshHome,
    [string]$ThemeHome,
    [int]$BootTimeoutSeconds = 240,
    [switch]$KeepScratch,
    [switch]$SkipUi,
    [switch]$ProbeUi
)

$ErrorActionPreference = 'Stop'
$exitCode = 1

# --- assertions --------------------------------------------------------------

$script:Results = @()

function Assert-True {
    # A defaulted message keeps an empty detail string from failing the assertion
    # machinery itself, which would hide what actually went wrong.
    param([Parameter(Mandatory)][bool]$Condition, [string]$Message = 'assertion failed')
    if (-not $Condition) { throw $Message }
}

function Test-Case {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Body)
    try {
        $detail = & $Body
        $script:Results += [pscustomobject]@{ Name = $Name; Ok = $true; Detail = [string]$detail }
        $suffix = if ($detail) { " — $detail" } else { '' }
        Write-Host ("  ok   {0}{1}" -f $Name, $suffix) -ForegroundColor Green
    }
    catch {
        $script:Results += [pscustomobject]@{ Name = $Name; Ok = $false; Detail = $_.Exception.Message }
        Write-Host ("  FAIL {0}" -f $Name) -ForegroundColor Red
        Write-Host ("       {0}" -f $_.Exception.Message) -ForegroundColor DarkRed
    }
}

function Write-Step {
    param([Parameter(Mandatory)][string]$Text)
    Write-Host ""
    Write-Host $Text -ForegroundColor Cyan
}

# --- paths -------------------------------------------------------------------

$repo = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $repo 'src/index.js'
if (-not (Test-Path -LiteralPath $entry)) { throw "not the importer repository: $entry is missing" }
# The loader wants an absolute module path; forward slashes survive YAML quoting.
$entrySpec = $entry.Replace('\', '/')

$realHome = if ($DshHome) { $DshHome } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$realProfile = Join-Path (Join-Path $realHome 'profiles') $ProfileName
if (-not (Test-Path -LiteralPath $realProfile)) { throw "profile not found: $realProfile" }
$realModules = Join-Path $realProfile 'node_modules'
if (-not (Test-Path -LiteralPath $realModules)) { throw "profile has no installed node_modules: $realModules" }

if (-not $Archive) {
    if ($env:DSH_TEST_ARCHIVE) { $Archive = $env:DSH_TEST_ARCHIVE }
    else {
        $sample = Get-ChildItem -LiteralPath $repo -Filter 'dsh-session-*.zip' -File |
            Select-Object -First 1
        if (-not $sample) { throw "no archive given: pass -Archive <path>, set DSH_TEST_ARCHIVE, or put a dsh-session-*.zip in $repo" }
        $Archive = $sample.FullName
    }
}
$Archive = (Resolve-Path -LiteralPath $Archive).Path
if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw "archive not found: $Archive" }

$dshCommand = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dshCommand) { throw 'dsh is not on PATH' }

$scratch = Join-Path $repo '.verify-home'
$scratchProfile = Join-Path (Join-Path $scratch 'profiles') $ProfileName
$nodeModulesLink = Join-Path $scratchProfile 'node_modules'
$overlay = Join-Path $scratch 'importer-overlay.yml'
$outLog = Join-Path $scratch 'dsh-web.out.log'
$errLog = Join-Path $scratch 'dsh-web.err.log'
$syntheticDir = Join-Path $scratch 'synthetic'

$script:Session = $null
$script:BoundPort = 0
$script:CdpPort = 0
$serverProcess = $null
$browserProcess = $null
$restoreDshHome = $env:DSH_HOME

<#
    Remove the scratch tree without ever walking a link.

    A recursive delete through a junction/symlink would delete the *target* —
    here, the real profile's node_modules. Every link is therefore unlinked
    first, and only then is the remaining tree removed.
#>
function Remove-ScratchTree {
    param([Parameter(Mandatory)][string]$Root)
    if (-not (Test-Path -LiteralPath $Root)) { return }
    $links = Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.LinkType }
    foreach ($link in $links) {
        try { [System.IO.Directory]::Delete($link.FullName, $false) }
        catch { Write-Warning "could not unlink $($link.FullName): $($_.Exception.Message)" }
    }
    Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
}

# --- HTTP helpers ------------------------------------------------------------

function Invoke-Api {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [string]$Method = 'POST',
        [string]$Body,
        [string]$InFile,
        [string]$ContentType = 'application/json'
    )
    $request = @{
        Uri               = $Uri
        Method            = $Method
        WebSession        = $script:Session
        SkipHttpErrorCheck = $true
        UseBasicParsing   = $true
    }
    if ($InFile) { $request.InFile = $InFile; $request.ContentType = $ContentType }
    elseif ($null -ne $Body) { $request.Body = $Body; $request.ContentType = $ContentType }
    $response = Invoke-WebRequest @request
    $json = $null
    try { $json = $response.Content | ConvertFrom-Json } catch { $json = $null }
    [pscustomobject]@{
        Status = [int]$response.StatusCode
        Json   = $json
        Raw    = [string]$response.Content
    }
}

# The RPC envelope is `{type, rpcId, method, payload:{args:<descriptor fields>}}`,
# and each endpoint's descriptor names its own arg fields (`session/list` wants
# `_request`, `session/page` wants `request`), so callers pass them explicitly.
function Invoke-Remote {
    param([Parameter(Mandatory)][string]$Endpoint, [hashtable]$Args = @{})
    $envelope = @{
        type    = 'client-request'
        rpcId   = [guid]::NewGuid().ToString()
        method  = $Endpoint
        payload = @{ args = $Args }
    } | ConvertTo-Json -Depth 12 -Compress
    Invoke-Api -Uri "$script:Base/api/$Endpoint" -Body $envelope
}

function Get-RemoteValue {
    param([Parameter(Mandatory)]$Response, [Parameter(Mandatory)][string]$Endpoint)
    $result = $Response.Json.result
    if ($null -eq $result) { throw "$Endpoint returned no result envelope: $($Response.Raw)" }
    if ($result.ok -ne $true) {
        $code = $result.error.code
        throw "$Endpoint failed ($code): $($result.error.message)"
    }
    $result.value
}

function Import-Archive {
    param(
        [string]$Path,
        [string]$InFile,
        [string]$Workspace = 'auto',
        [string]$SessionId,
        [switch]$DryRun
    )
    $query = "workspace=$Workspace"
    if ($Path) { $query += "&path=$([uri]::EscapeDataString($Path))" }
    if ($SessionId) { $query += "&sessionId=$([uri]::EscapeDataString($SessionId))" }
    if ($DryRun) { $query += '&dryRun=true' }
    $request = @{ Uri = "$script:Base/api/session.import?$query" }
    if ($InFile) {
        Invoke-Api @request -InFile $InFile -ContentType 'application/zip'
    }
    else {
        Invoke-Api @request -Body '{}' -ContentType 'application/json'
    }
}

# --- scratch instance --------------------------------------------------------

<#
    Locate a Chromium-family browser for the headless UI leg.

    Edge ships with Windows and Chrome is common; either drives the same
    DevTools Protocol.
    @returns the executable path, or $null when none is installed.
#>
function Find-Browser {
    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
    foreach ($root in $roots) {
        foreach ($relative in 'Microsoft\Edge\Application\msedge.exe', 'Google\Chrome\Application\chrome.exe') {
            $candidate = Join-Path $root $relative
            if (Test-Path -LiteralPath $candidate) { return $candidate }
        }
    }
    return $null
}

<#
    Stop one launched process and its descendants.

    The direct child is killed first for the reason documented on
    Stop-ScratchInstance; the tree kill and the port sweep are best effort
    because a restricted policy can refuse both.
#>
function Stop-LaunchedProcess {
    param($Process, [int]$ListenPort = 0)
    if ($Process -and -not $Process.HasExited) {
        if ($IsWindows) { & taskkill.exe /PID $Process.Id /T /F *> $null }
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        $Process.WaitForExit(15000) | Out-Null
    }
    if ($ListenPort -le 0) { return }
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $owners = @(Get-PortOwner -ListenPort $ListenPort)
        if ($owners.Count -eq 0) { return }
        foreach ($owner in $owners) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 250
    }
}

<#
    Process ids currently listening on one port.

    Used both to prove the scratch instance is really gone and as a second
    cleanup pass. `Get-NetTCPConnection` is authoritative but unavailable under
    a restricted policy, so `netstat -ano` backs it up. An empty result can mean
    "nothing listening" or "the platform refused the query", so callers treat it
    as "nothing to kill" rather than as proof of absence.
#>
function Get-PortOwner {
    param([int]$ListenPort)
    if ($ListenPort -le 0) { return @() }
    if ($IsWindows) {
        try {
            $owners = @(Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction Stop |
                    Select-Object -ExpandProperty OwningProcess -Unique)
            if ($owners.Count -gt 0) { return $owners }
        }
        catch { }
        try {
            return @(& netstat.exe -ano 2>$null |
                Select-String -Pattern ":$ListenPort\s+.*LISTENING\s+(\d+)\s*$" |
                ForEach-Object { [int]$_.Matches[0].Groups[1].Value } |
                Select-Object -Unique)
        }
        catch { return @() }
    }
    try { return @(& lsof -ti "tcp:$ListenPort" 2>$null | ForEach-Object { [int]$_ }) }
    catch { return @() }
}

<#
    Stop the scratch instance and every process it left behind.

    The launched command is a shell wrapper around `dsh`, so the server is a
    *child* of the process handle held here. Killing the direct child first is
    what actually lets this script return: PowerShell keeps draining the child's
    redirected streams and only finishes once that child's handles close, so a
    surviving child hangs whoever is capturing this script's output. The tree
    kill and the port sweep then clean up the server the wrapper left behind;
    both can be refused by a restricted policy, which is why neither is the only
    mechanism.
#>
function Stop-ScratchInstance {
    param([int]$ListenPort)
    if ($serverProcess) {
        if ($IsWindows) { & taskkill.exe /PID $serverProcess.Id /T /F *> $null }
        Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
        $serverProcess.WaitForExit(15000) | Out-Null
    }
    if ($ListenPort -le 0) { return }
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $owners = @(Get-PortOwner -ListenPort $ListenPort)
        if ($owners.Count -eq 0) { break }
        foreach ($owner in $owners) { Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 250
    }
    $remaining = @(Get-PortOwner -ListenPort $ListenPort)
    if ($remaining.Count -gt 0) {
        Write-Warning "port $ListenPort is still held by pid $($remaining -join ', '); stop it manually"
    }
}

Write-Host "dsh-session-importer end-to-end verification" -ForegroundColor White
Write-Host "  repository : $repo"
Write-Host "  archive    : $Archive"
Write-Host "  real home  : $realHome (profile '$ProfileName')"
Write-Host "  scratch    : $scratch"

try {
    Remove-ScratchTree -Root $scratch
    New-Item -ItemType Directory -Force -Path $scratchProfile, $syntheticDir,
        (Join-Path $scratch 'sessions'), (Join-Path $scratch 'attachments'),
        (Join-Path $scratch 'storages') | Out-Null

    # Only the small config files are copied; the installed tree is linked.
    foreach ($name in 'package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml') {
        $source = Join-Path $realProfile $name
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $scratchProfile $name) }
    }

    # Carry the deployment's theme into the scratch home so the browser leg sees
    # the same skin, material preset, and wallpaper the user sees.
    $themeSource = if ($ThemeHome) { $ThemeHome } else { $realHome }
    foreach ($name in 'dream-skin.json', 'settings.yaml') {
        $source = Join-Path $themeSource $name
        if (Test-Path -LiteralPath $source) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $scratch $name)
            Write-Host "  theme state: $name"
        }
    }
    $linkType = if ($IsWindows) { 'Junction' } else { 'SymbolicLink' }
    New-Item -ItemType $linkType -Path $nodeModulesLink -Target $realModules | Out-Null

    # Mount this package by absolute path so the source under test is this
    # checkout, never an installed copy.
    #
    # The package may already be installed in the profile: `dsh plugin add`
    # appends it to the bundle list, whose patch inserts this same row id, and
    # composing a second insert fails the whole boot with a duplicate-id error.
    # The overlay therefore *targets* an existing row when the profile has one
    # and inserts otherwise; both shapes end with one row pointing here.
    $env:DSH_HOME = $scratch
    $baseline = & dsh --profile $ProfileName --dump-config 2>&1 | Out-String
    if ($baseline -match 'id: session-importer') {
        Write-Host "  profile already declares the row; the overlay repoints it at this checkout"
        @(
            '# generated by scripts/verify-e2e.ps1 — repoints the installed row at this checkout',
            '- id: session-importer',
            "  name: '$entrySpec'"
        ) | Set-Content -LiteralPath $overlay -Encoding utf8
    }
    else {
        @(
            '# generated by scripts/verify-e2e.ps1 — mounts this package by absolute path',
            '- insert:',
            '    - id: session-importer',
            "      name: '$entrySpec'"
        ) | Set-Content -LiteralPath $overlay -Encoding utf8
    }

    Write-Step 'Composition'
    Test-Case 'the overlay mounts this checkout as the only plugin row' {
        $dump = & dsh --profile $ProfileName --patch $overlay --dump-config 2>&1 | Out-String
        $rows = ([regex]::Matches($dump, 'id: session-importer')).Count
        Assert-True ($rows -eq 1) "the composed tree has $rows session-importer rows"
        Assert-True ($dump -match 'src/index\.js') 'the row does not point at this checkout'
        'row resolved'
    }

    Write-Step 'Boot'
    $pwshExe = (Get-Process -Id $PID).Path
    $command = "& dsh --profile $ProfileName --patch '$($overlay.Replace("'", "''"))' --port $Port --no-open"
    $serverProcess = Start-Process -FilePath $pwshExe `
        -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', $command) `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    Write-Host "  pid $($serverProcess.Id); waiting up to ${BootTimeoutSeconds}s for the URL line"

    $deadline = (Get-Date).AddSeconds($BootTimeoutSeconds)
    $url = $null
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $outLog) {
            # A zero-byte log reads back as $null, so the raw text is coerced.
            $text = [string](Get-Content -LiteralPath $outLog -Raw -ErrorAction SilentlyContinue)
            $match = [regex]::Match($text, 'dsh web: (http://\S+)')
            if ($match.Success) { $url = $match.Groups[1].Value; break }
        }
        if ($serverProcess.HasExited) {
            throw "the scratch instance exited with code $($serverProcess.ExitCode)`n$(Get-Content -LiteralPath $errLog -Raw -ErrorAction SilentlyContinue)"
        }
        Start-Sleep -Milliseconds 500
    }
    Assert-True ($null -ne $url) "timed out waiting for the dsh web URL; see $outLog"

    $uri = [uri]$url
    $script:Base = '{0}://{1}:{2}' -f $uri.Scheme, $uri.Host, $uri.Port
    $script:BoundPort = $uri.Port
    $token = [regex]::Match($uri.Query, 'token=([^&]+)').Groups[1].Value
    Assert-True ($token -ne '') "the URL carries no token: $url"
    Write-Host "  listening on $script:Base"

    $null = Invoke-WebRequest -Uri "$script:Base/?token=$token" -SessionVariable session -UseBasicParsing
    $script:Session = $session
    $indexHtml = (Invoke-WebRequest -Uri "$script:Base/" -WebSession $script:Session -UseBasicParsing).Content

    Write-Step 'Plugin halves'
    Test-Case 'the client bundle is registered in __DSH_BOOT__' {
        $key = 'globalThis["__DSH_BOOT__"] = '
        $start = $indexHtml.IndexOf($key)
        Assert-True ($start -ge 0) 'the page carries no __DSH_BOOT__ payload'
        $end = $indexHtml.IndexOf('</script>', $start)
        $boot = $indexHtml.Substring($start + $key.Length, $end - $start - $key.Length).TrimEnd(';').Trim() | ConvertFrom-Json
        $script:BootEntry = $boot.entries | Where-Object { $_.id -eq 'dsh-session-importer' }
        Assert-True ($null -ne $script:BootEntry) 'dsh-session-importer is absent from the composed client graph'
        $script:BootEntry.url
    }

    Test-Case 'the served bundle is this package client half' {
        # A boot entry's url is relative to the document, so it carries no
        # leading slash; joining it onto the origin needs one.
        $bundlePath = [string]$script:BootEntry.url
        if (-not $bundlePath.StartsWith('/')) { $bundlePath = '/' + $bundlePath }
        $bundle = Invoke-Api -Uri ($script:Base + $bundlePath) -Method GET
        Assert-True ($bundle.Status -eq 200) "bundle answered HTTP $($bundle.Status)"
        foreach ($marker in 'sidebar.footer.action', 'shell.overlay', '/api/session.import', 'data-dsh-session-importer', 'IconProjectAddOutlineRegular') {
            Assert-True ($bundle.Raw.Contains($marker)) "the bundle does not mention $marker"
        }
        "$($bundle.Raw.Length) bytes"
    }

    Test-Case 'the plugin fiber is active (both halves loaded cleanly)' {
        $rows = Get-RemoteValue (Invoke-Remote -Endpoint 'pluginInventory/list') 'pluginInventory/list'
        $row = $rows.entries | Where-Object { $_.moduleName -like '*dsh-session-importer*' }
        Assert-True ($null -ne $row) 'the loader reports no session-importer entry'
        Assert-True ($row.enabled -eq $true) 'the entry is disabled'
        Assert-True ($row.fiberPhase -eq 'active') "the fiber phase is '$($row.fiberPhase)'"
        'active'
    }

    Test-Case 'the route answers a metadata probe' {
        $probe = Invoke-Api -Uri "$script:Base/api/session.import" -Method GET
        Assert-True ($probe.Status -eq 200) "probe answered HTTP $($probe.Status)"
        Assert-True ($probe.Json.ok -eq $true) 'the probe did not report ok'
        Assert-True ($probe.Json.limits.maxUploadBytes -gt 0) 'the probe reported no upload limit'
        # Synthetic archives below have to be written in the generation this
        # deployment writes, so the probe is also how the script learns it.
        $script:InstalledFormat = [int]$probe.Json.format.installedVersion
        Assert-True ($script:InstalledFormat -gt 0) "the probe reported format version '$($probe.Json.format.installedVersion)'"
        "limit $([math]::Round($probe.Json.limits.maxUploadBytes / 1MB)) MiB, session format v$($script:InstalledFormat)"
    }

    Write-Step 'Import planning'
    $plan = $null
    Test-Case 'a dry run plans every log without writing' {
        $dry = Import-Archive -Path $Archive -DryRun
        Assert-True ($dry.Status -eq 200) "dry run answered HTTP $($dry.Status)"
        Assert-True ($dry.Json.ok -eq $true) "dry run reported: $($dry.Json.error)"
        $script:Plan = $dry.Json.plan
        $expectedEntries = 1 + $script:Plan.subagents + $script:Plan.media + $script:Plan.files + $script:Plan.ignored.Count
        Assert-True ($script:Plan.entries -eq $expectedEntries) "entry accounting is off: $($script:Plan.entries) vs $expectedEntries"
        Assert-True ($script:Plan.sessions.Count -eq 1 + $script:Plan.subagents) 'the plan lost a subagent log'
        $events = ($script:Plan.sessions | Measure-Object -Property events -Sum).Sum
        Assert-True ($events -gt 0) 'the plan contains no events'
        $script:RootId = $script:Plan.rootId
        $script:ChildId = ($script:Plan.sessions | Where-Object { $_.role -eq 'subagent' } | Select-Object -First 1).sessionId
        "$($script:Plan.sessions.Count) sessions, $events events, $($script:Plan.media) media"
    }

    Test-Case 'the planned root is the archive root and keeps its id' {
        Assert-True ($null -ne $script:RootId) 'the plan names no root session'
        Assert-True ($script:Plan.root -match '^session(\.v\d+)?\.jsonl$') "unexpected root entry name '$($script:Plan.root)'"
        "$($script:RootId) → $($script:Plan.targetCwd) ($($script:Plan.targetCwdSource))"
    }

    # The sample is an archive from an older DSH, so the plan has to say that its
    # generation differs from this installation's before anything is written.
    Test-Case 'the plan reports the archive format against the installed one' {
        $format = $script:Plan.format
        Assert-True ($null -ne $format) 'the plan carries no format report'
        Assert-True ([int]$format.installedVersion -eq $script:InstalledFormat) "the plan reports installed v$($format.installedVersion), the probe said v$($script:InstalledFormat)"
        Assert-True ([int]$format.archivedVersion -ne $script:InstalledFormat) "the sample archive already matches the installed generation v$($script:InstalledFormat), so this check can no longer prove a migration"
        Assert-True ($format.migrationRequired -eq $true) 'the plan did not report that a migration is required'
        "archive v$($format.archivedVersion) → installed v$($format.installedVersion)"
    }

    Write-Step 'Import'
    Test-Case 'the archive imports through the Session services' {
        $import = Import-Archive -Path $Archive
        Assert-True ($import.Status -eq 200) "import answered HTTP $($import.Status): $($import.Raw)"
        $script:Imported = $import.Json
        Assert-True ($script:Imported.ok -eq $true) "import reported: $($script:Imported.errors -join '; ')"
        Assert-True ($script:Imported.imported.Count -eq $script:Plan.sessions.Count) "imported $($script:Imported.imported.Count) of $($script:Plan.sessions.Count) sessions"
        Assert-True ($script:Imported.errors.Count -eq 0) "errors: $($script:Imported.errors -join '; ')"
        Assert-True ([int]$script:Imported.format.migratedSessions -eq $script:Plan.sessions.Count) "the response reports $($script:Imported.format.migratedSessions) migrated logs, the plan has $($script:Plan.sessions.Count)"
        Assert-True (($script:Imported.warnings -join ' ') -match 'migrated to v') 'no warning explains the format migration'
        # Every imported session must name the generation it came from, so a
        # silently untranslated log cannot pass as migrated.
        $stale = @($script:Imported.imported | Where-Object { $_.migratedFrom -ne $script:Imported.format.archivedVersion })
        Assert-True ($stale.Count -eq 0) "$($stale.Count) imported session(s) do not name their source generation"
        "$($script:Imported.imported.Count) sessions, migrated from v$($script:Imported.format.archivedVersion)"
    }

    Test-Case 'every imported log is read back by the reader' {
        Assert-True ($script:Imported.verified.Count -eq $script:Imported.imported.Count) 'not every imported log verified'
        ($script:Imported.verified | Measure-Object -Property events -Sum).Sum.ToString() + ' events re-read'
    }

    Test-Case 'referenced attachments are restored' {
        $expected = $script:Plan.media + $script:Plan.files
        Assert-True ($script:Imported.attachments.unavailable -ne $true) 'the attachment store is not mounted'
        Assert-True ($script:Imported.attachments.failed -eq 0) "failed: $($script:Imported.attachments.failed)"
        Assert-True ($script:Imported.attachments.restored -eq $expected) "restored $($script:Imported.attachments.restored) of $expected"
        "$($script:Imported.attachments.restored) restored"
    }

    Test-Case 'the root session is filed under its workspace' {
        Assert-True ($script:Imported.workspace.grouped -eq $true) "not grouped: $($script:Imported.workspace.reason)"
        Assert-True ($script:Imported.workspace.path -eq $script:Plan.targetCwd) "grouped under '$($script:Imported.workspace.path)'"
        $script:Imported.workspace.path
    }

    Write-Step 'Visibility'
    Test-Case 'the host session list carries the imported sessions' {
        $list = Get-RemoteValue (Invoke-Remote -Endpoint 'session/list' -Args @{ _request = @{} }) 'session/list'
        $ids = @($list.items | ForEach-Object { $_.sessionId })
        foreach ($session in $script:Plan.sessions) {
            Assert-True ($ids -contains $session.sessionId) "session/list is missing $($session.sessionId)"
        }
        $root = $list.items | Where-Object { $_.sessionId -eq $script:RootId }
        Assert-True ($null -ne $root) 'the root session row is missing'
        Assert-True ($root.cwd -eq $script:Plan.targetCwd) "the row reports cwd '$($root.cwd)'"
        Assert-True ($root.origin -ne 'subagent') 'the root row is marked as a subagent, so the sidebar would hide it'
        "$($ids.Count) rows; root cwd ok"
    }

    Test-Case 'the GUI page projection loads the root session' {
        $events = ($script:Plan.sessions | Where-Object { $_.role -eq 'root' }).events
        $page = Invoke-Remote -Endpoint 'session/page' -Args @{
            request = @{
                address    = @{ kind = 'session'; sessionId = $script:RootId }
                throughSeq = $events - 1
            }
        }
        $null = Get-RemoteValue $page 'session/page'
        "cursor $($events - 1)"
    }

    Test-Case 'the GUI page projection loads a subagent child' {
        $childEvents = ($script:Plan.sessions | Where-Object { $_.sessionId -eq $script:ChildId }).events
        $page = Invoke-Remote -Endpoint 'session/page' -Args @{
            request = @{
                address    = @{
                    kind            = 'subagent'
                    parentSessionId = $script:RootId
                    childSessionId  = $script:ChildId
                    mode            = 'continuable'
                }
                throughSeq = $childEvents - 1
            }
        }
        $null = Get-RemoteValue $page 'session/page'
        "$($script:ChildId) cursor $($childEvents - 1)"
    }

    Write-Step 'Idempotency and repair'
    Test-Case 're-importing writes nothing and reports alreadyImported' {
        $again = Import-Archive -Path $Archive
        Assert-True ($again.Status -eq 200) "re-import answered HTTP $($again.Status)"
        Assert-True ($again.Json.alreadyImported -eq $true) 'the repeat import did not report alreadyImported'
        Assert-True ($again.Json.imported.Count -eq 0) "the repeat import wrote $($again.Json.imported.Count) sessions"
        Assert-True ($again.Json.skipped.Count -eq $script:Plan.sessions.Count) "skipped $($again.Json.skipped.Count) of $($script:Plan.sessions.Count)"
        "$($again.Json.skipped.Count) skipped"
    }

    Test-Case 'a dropped descendant is repaired by re-importing' {
        $dir = Get-ChildItem -LiteralPath (Join-Path $scratch 'sessions') -Recurse -Directory -Force |
            Where-Object { $_.Name -eq $script:ChildId } | Select-Object -First 1
        Assert-True ($null -ne $dir) "no on-disk log directory for $($script:ChildId)"
        Remove-Item -LiteralPath $dir.FullName -Recurse -Force
        $repair = Import-Archive -Path $Archive
        Assert-True ($repair.Status -eq 200) "repair answered HTTP $($repair.Status)"
        Assert-True ($repair.Json.imported.Count -eq 1) "repair wrote $($repair.Json.imported.Count) sessions (expected exactly the missing one)"
        Assert-True ($repair.Json.imported[0].sessionId -eq $script:ChildId) 'repair wrote the wrong session'
        Assert-True (Test-Path -LiteralPath $dir.FullName) 'the repaired log directory did not come back'
        "repaired $($script:ChildId)"
    }

    Write-Step 'Refusals'
    Test-Case 'a raw-body upload imports a minimal archive' {
        $id = "session-$([guid]::NewGuid())"
        $staged = Join-Path $syntheticDir 'minimal'
        New-Item -ItemType Directory -Force -Path $staged | Out-Null
        # Filed under the repository itself, not the archive's workspace, so the
        # `workspace=current` check below has two different cwds to choose from.
        # The generation is the one this deployment writes, so the archive is a
        # current export and needs no migration.
        $lines = @(
            (@{ type = 'session'; version = $script:InstalledFormat; id = $id; createdAt = 1789352471075; cwd = $repo; isSeeded = $false; delegationDepth = 0 } | ConvertTo-Json -Compress),
            '{"type":"permission/preset","seq":0,"time":1789352471123,"data":{"preset":"workspace-write"}}',
            '{"type":"sandbox/mode","seq":1,"time":1789352471124,"data":{"mode":"workspace-write"}}'
        )
        $logName = "session.v$($script:InstalledFormat).jsonl"
        Set-Content -LiteralPath (Join-Path $staged $logName) -Value $lines -Encoding utf8
        $zip = Join-Path $syntheticDir 'minimal.zip'
        Compress-Archive -Path (Join-Path $staged $logName) -DestinationPath $zip -Force
        $upload = Import-Archive -InFile $zip
        Assert-True ($upload.Status -eq 200) "upload answered HTTP $($upload.Status): $($upload.Raw)"
        Assert-True ($upload.Json.imported.Count -eq 1) "upload imported $($upload.Json.imported.Count) sessions"
        Assert-True ($upload.Json.verified.Count -eq 1) 'the uploaded session was not verified'
        Assert-True ([int]$upload.Json.format.migratedSessions -eq 0) "a current archive was migrated ($($upload.Json.format.migratedSessions) logs)"
        $script:SyntheticId = $id
        'uploaded and verified'
    }

    # The dialog sends the session the user has open, so `workspace=current` must
    # resolve to *that* session's workspace rather than the Host process's cwd.
    Test-Case 'workspace=current resolves against the named session' {
        Assert-True ($null -ne $script:SyntheticId) 'no uploaded session to resolve against'
        $dry = Import-Archive -Path $Archive -DryRun -Workspace 'current' -SessionId $script:SyntheticId
        Assert-True ($dry.Status -eq 200) "dry run answered HTTP $($dry.Status)"
        Assert-True ($dry.Json.ok -eq $true) "dry run reported: $($dry.Json.error)"
        Assert-True ($dry.Json.plan.targetCwdSource -eq 'current') "resolved from '$($dry.Json.plan.targetCwdSource)'"
        Assert-True ($dry.Json.plan.targetCwd -eq $repo) "resolved to '$($dry.Json.plan.targetCwd)' instead of $repo"
        "current → $repo"
    }

    # "I chose current workspace and nothing happened": when the session is
    # already imported, nothing is written and the workspace cannot change — the
    # response has to say so instead of looking like a no-op.
    Test-Case 'a repeat import with a different workspace explains why nothing moved' {
        $again = Import-Archive -Path $Archive -Workspace 'current' -SessionId $script:SyntheticId
        Assert-True ($again.Status -eq 200) "repeat import answered HTTP $($again.Status)"
        Assert-True ($again.Json.alreadyImported -eq $true) 'the repeat import did not report alreadyImported'
        Assert-True ($again.Json.imported.Count -eq 0) 'the repeat import wrote sessions'
        $workspace = $again.Json.workspace
        Assert-True ($workspace.grouped -eq $false) 'the repeat import claimed to regroup an existing session'
        Assert-True ($workspace.unchanged -eq $true) 'the repeat import did not flag the workspace as unchanged'
        Assert-True (($workspace.reason -join ' ') -match 'cannot be rewritten|immutable|header') "the reason does not explain the immutability: $($workspace.reason)"
        Assert-True (($workspace.reason -join ' ') -match 'Delete that session') "the reason does not say what to do: $($workspace.reason)"
        'reported as unchanged with instructions'
    }

    # A "current" request that cannot be resolved must surface the directory it
    # actually used, because that directory decides the workspace group.
    Test-Case 'an unresolvable current workspace reports the fallback it used' {
        $dry = Import-Archive -Path $Archive -DryRun -Workspace 'current' -SessionId "session-$([guid]::NewGuid())"
        Assert-True ($dry.Status -eq 200) "dry run answered HTTP $($dry.Status)"
        Assert-True ($dry.Json.plan.targetCwdSource -eq 'process') "resolved from '$($dry.Json.plan.targetCwdSource)'"
        Assert-True ($null -ne $dry.Json.plan.targetCwdFallback) 'the fallback was not explained'
        Assert-True ($dry.Json.plan.targetCwdFallback -match 'no stored cwd') "unhelpful explanation: $($dry.Json.plan.targetCwdFallback)"
        "fallback to $($dry.Json.plan.targetCwd), explained"
    }

    Test-Case 'a non-ZIP body is refused with 400' {
        $bad = Join-Path $syntheticDir 'not-a-zip.zip'
        Set-Content -LiteralPath $bad -Value 'this is definitely not a zip archive' -Encoding utf8
        $response = Import-Archive -InFile $bad
        Assert-True ($response.Status -eq 400) "answered HTTP $($response.Status)"
        Assert-True ($response.Json.ok -eq $false) 'the refusal did not report ok=false'
        Assert-True ($response.Json.error -match 'ZIP') "unhelpful message: $($response.Json.error)"
        $response.Json.error
    }

    Test-Case 'an unknown event vocabulary is refused and rolled back' {
        $id = "session-$([guid]::NewGuid())"
        $staged = Join-Path $syntheticDir 'unknown-event'
        New-Item -ItemType Directory -Force -Path $staged | Out-Null
        # A writer admits an unknown type (only the reader enforces the
        # vocabulary), so this log is written and then refused by the read-back,
        # which is the path that has to roll the files away again.
        $lines = @(
            (@{ type = 'session'; version = $script:InstalledFormat; id = $id; createdAt = 1789352471075; cwd = $script:Plan.targetCwd; isSeeded = $false; delegationDepth = 0 } | ConvertTo-Json -Compress),
            '{"type":"future/unknown-event","seq":0,"time":1789352471123,"data":{"whatever":true}}'
        )
        $logName = "session.v$($script:InstalledFormat).jsonl"
        Set-Content -LiteralPath (Join-Path $staged $logName) -Value $lines -Encoding utf8
        $zip = Join-Path $syntheticDir 'unknown-event.zip'
        Compress-Archive -Path (Join-Path $staged $logName) -DestinationPath $zip -Force
        $response = Import-Archive -InFile $zip
        Assert-True ($response.Status -eq 500) "answered HTTP $($response.Status)"
        Assert-True ($response.Json.imported.Count -eq 0) 'a session the reader refuses was reported as imported'
        Assert-True (($response.Json.errors -join ' ') -match 'verify failed') "no verification error: $($response.Json.errors -join '; ')"
        Assert-True (($response.Json.errors -join ' ') -match 'rolled back') 'the failure was not reported as rolled back'
        $leftover = Get-ChildItem -LiteralPath (Join-Path $scratch 'sessions') -Recurse -Directory -Force |
            Where-Object { $_.Name -eq $id }
        Assert-True ($null -eq $leftover) 'the refused log was left on disk'
        'refused, rolled back, no leftover'
    }

    # --- headless browser: the injected menu item ----------------------------

    Write-Step 'Browser (headless)'
    if ($SkipUi) {
        Write-Host "  skipped (-SkipUi)" -ForegroundColor Yellow
    }
    else {
        $browser = Find-Browser
        if ($null -eq $browser) {
            Write-Host "  skipped: no Edge or Chrome installed" -ForegroundColor Yellow
        }
        else {
            $browserProfile = Join-Path $scratch 'browser-profile'
            New-Item -ItemType Directory -Force -Path $browserProfile | Out-Null
            $evidence = Join-Path $repo 'docs/evidence'
            $uiOut = Join-Path $scratch 'ui-report.json'
            $uiErr = Join-Path $scratch 'ui-report.err.log'
            Write-Host "  $browser"
            # Port 0 makes the browser choose and publish its DevTools port.
            $browserProcess = Start-Process -FilePath $browser -ArgumentList @(
                '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
                '--disable-extensions', '--disable-background-networking', '--mute-audio',
                '--window-size=1440,900', '--remote-debugging-port=0', '--remote-allow-origins=*',
                "--user-data-dir=$browserProfile", 'about:blank'
            ) -PassThru -RedirectStandardOutput (Join-Path $scratch 'browser.out.log') `
                -RedirectStandardError (Join-Path $scratch 'browser.err.log')

            $portFile = Join-Path $browserProfile 'DevToolsActivePort'
            $cdpDeadline = (Get-Date).AddSeconds(45)
            while (-not (Test-Path -LiteralPath $portFile) -and (Get-Date) -lt $cdpDeadline) { Start-Sleep -Milliseconds 250 }
            if (-not (Test-Path -LiteralPath $portFile)) {
                Test-Case 'the headless browser exposes a DevTools endpoint' {
                    throw "no DevToolsActivePort in $browserProfile; see $scratch\browser.err.log"
                }
            }
            else {
                $cdpPort = [int]([string](Get-Content -LiteralPath $portFile -TotalCount 1)).Trim()
                $script:CdpPort = $cdpPort
                Write-Host "  devtools on $cdpPort"
                $uiArgs = @((Join-Path $PSScriptRoot 'verify-ui.mjs'), '--cdp', $cdpPort, '--base', $script:Base, '--token', $token, '--evidence', $evidence)
                # A fresh browser profile opens the first-run workspace picker, so
                # tell the leg which workspace owns the imported sessions — and
                # which session was imported, so its sidebar row is selected
                # exactly rather than guessed from its label.
                $uiArgs += @('--workspace', (Split-Path -Leaf $script:Plan.targetCwd))
                $uiArgs += @('--session', $script:RootId)
                if ($ProbeUi) { $uiArgs += @('--probe', 'true') }
                & node @uiArgs 1> $uiOut 2> $uiErr
                $uiExit = $LASTEXITCODE
                $report = $null
                try { $report = Get-Content -LiteralPath $uiOut -Raw | ConvertFrom-Json } catch { }
                if ($ProbeUi) {
                    Write-Host "  diagnostic dump:" -ForegroundColor Yellow
                    Get-Content -LiteralPath $uiOut -Raw -ErrorAction SilentlyContinue | Write-Host
                    Get-Content -LiteralPath $uiErr -Raw -ErrorAction SilentlyContinue | Write-Host
                }
                elseif ($null -eq $report) {
                    Test-Case 'the headless browser reports the menu injection' {
                        throw "verify-ui.mjs exited $uiExit without a readable report; see $uiOut and $uiErr"
                    }
                }
                else {
                    Test-Case 'the client half boots in a real browser' {
                        $why = [string]($report.errors -join '; ')
                        if ($why -eq '') { $why = 'the import trigger never rendered' }
                        Assert-True ($report.prepare.booted -eq $true) $why
                        'trigger rendered'
                    }
                    Test-Case 'a Session opens and its more-actions menu opens' {
                        Assert-True ($report.prepare.pickedWorkspace -eq $true) 'the first-run workspace picker did not accept the workspace'
                        Assert-True ($report.prepare.openedSession -eq $true) 'no session row could be clicked in the sidebar'
                        Assert-True ($report.prepare.menuOpen -eq $true) ("header menu never opened; page was " + ($report.prepare.diag | ConvertTo-Json -Compress -Depth 5))
                        'workspace picked, session open, header menu open'
                    }
                    Test-Case 'the import item sits directly after "Download session log"' {
                        Assert-True ($report.prepare.hasDownload -eq $true) "the menu has no download item: $($report.prepare.menuItems -join ' | ')"
                        Assert-True ($report.prepare.hasImport -eq $true) "the menu has no import item: $($report.prepare.menuItems -join ' | ')"
                        Assert-True ($report.prepare.importAfterDownload -eq $true) "order is wrong: $($report.prepare.menuItems -join ' | ')"
                        Assert-True ($report.prepare.injected -eq $true) 'the item is present but not the one this plugin injected'
                        $report.prepare.menuItems -join ' | '
                    }
                    Test-Case 'clicking the injected item opens the import dialog' {
                        Assert-True ($null -ne $report.activate) 'the item was never clicked'
                        $why = [string]($report.activate.errors -join '; ')
                        if ($why -eq '') { $why = 'the dialog did not open' }
                        Assert-True ($report.activate.dialogOpened -eq $true) $why
                        'dialog opened'
                    }
                    # The dialog's fields must stay legible under the *deployed*
                    # skin and material, not just the plugin defaults: a native
                    # select was unreadable because the browser paints its fill
                    # and popup outside the theme. Both controls now use the
                    # app's own primitives, and this pins that.
                    Test-Case 'the dialog fields and workspace menu are legible' {
                        $dialog = $report.dialog
                        Assert-True ($null -ne $dialog) 'the dialog could not be inspected'
                        $problems = [System.Collections.Generic.List[string]]::new()
                        foreach ($problem in $dialog.errors) { $problems.Add([string]$problem) }
                        if ($dialog.usesNativeSelect -eq $true) { $problems.Add('the workspace choice is a native select again, whose popup ignores the theme') }
                        foreach ($field in $dialog.fields) {
                            if ($field.contrast -lt 4.5) { $problems.Add("$($field.name): contrast $($field.contrast) between $($field.color) and its composited backdrop") }
                            # A zero-size field means the probe measured a hidden
                            # element (the dialog's own file picker), not copy.
                            if ($field.name -eq 'hostPathInput' -and ($field.width -le 0 -or $field.height -le 0)) {
                                $problems.Add("$($field.name): measured a $($field.width)x$($field.height) element")
                            }
                        }
                        if ($dialog.workspaceItems.Count -ne 3) { $problems.Add("the workspace menu lists $($dialog.workspaceItems.Count) options, expected the 3 policies") }
                        foreach ($item in $dialog.workspaceItems) {
                            if ($item.contrast -lt 4.5) { $problems.Add("workspace option '$($item.label)': contrast $($item.contrast) between $($item.color) and its composited backdrop") }
                            if ($item.clipped -eq $true) { $problems.Add("workspace option '$($item.label)': the label is wider than its box") }
                        }
                        # The list must not be cut off by the dialog or the viewport.
                        if ($dialog.menuClipped -eq $true) { $problems.Add("the workspace menu is outside the viewport ($($dialog.menuRect | ConvertTo-Json -Compress) in $($dialog.viewport | ConvertTo-Json -Compress))") }
                        if ($dialog.triggerClipped -eq $true) { $problems.Add('the workspace trigger label is wider than its box') }
                        if ($dialog.triggerWidth -gt $dialog.dialogWidth) { $problems.Add("the workspace trigger ($($dialog.triggerWidth)px) is wider than the dialog ($($dialog.dialogWidth)px)") }
                        $detail = 'fields and every workspace option are legible, and the list fits'
                        if ($problems.Count -gt 0) { $detail = $problems -join '; ' }
                        Assert-True ($problems.Count -eq 0) $detail
                        $worst = ($dialog.workspaceItems | Measure-Object -Property contrast -Minimum).Minimum
                        "trigger '$($dialog.triggerLabel)' ($($dialog.triggerWidth)px in $($dialog.dialogWidth)px); $($dialog.workspaceItems.Count) options, lowest contrast $worst; list $($dialog.menuRect.width)x$($dialog.menuRect.height) in $($dialog.viewport.width)x$($dialog.viewport.height)"
                    }
                    Write-Host "  screenshots: docs/evidence/import-menu.png, docs/evidence/import-dialog.png" -ForegroundColor DarkGray
                }
            }
        }
    }

    # --- summary -------------------------------------------------------------

    $passed = @($script:Results | Where-Object { $_.Ok }).Count
    $failed = @($script:Results | Where-Object { -not $_.Ok })
    Write-Host ""
    Write-Host ("{0}/{1} checks passed" -f $passed, $script:Results.Count) -ForegroundColor $(if ($failed.Count) { 'Red' } else { 'Green' })
    foreach ($failure in $failed) { Write-Host ("  FAILED: {0} — {1}" -f $failure.Name, $failure.Detail) -ForegroundColor Red }
    if ($failed.Count -gt 0) { $exitCode = 1 } else { $exitCode = 0 }
}
catch {
    Write-Host ""
    Write-Host "verification aborted: $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
}
finally {
    if ($serverProcess) { Write-Host "stopping the scratch instance (pid $($serverProcess.Id))" }
    if ($browserProcess) { Stop-LaunchedProcess -Process $browserProcess -ListenPort $script:CdpPort }
    Stop-ScratchInstance -ListenPort $script:BoundPort
    if ($restoreDshHome) { $env:DSH_HOME = $restoreDshHome } else { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue }
    if ($KeepScratch) {
        Write-Host "scratch home kept at $scratch" -ForegroundColor Yellow
    }
    else {
        Remove-ScratchTree -Root $scratch
        # Safety check: the real profile's install must be untouched. The scratch
        # tree links to it, so a cleanup bug would show up right here.
        if (-not (Test-Path -LiteralPath $realModules)) {
            Write-Host "WARNING: $realModules is gone — the scratch cleanup followed the link" -ForegroundColor Red
            if ($exitCode -eq 0) { $exitCode = 2 }
        }
        else { Write-Host "scratch home removed; real profile intact" -ForegroundColor DarkGray }
    }
}

exit $exitCode
