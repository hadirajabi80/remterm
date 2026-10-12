# Builds Remterm without the Wails CLI: frontend bundle, the Remote Desktop
# engine (C#, self-contained: no .NET install needed), then a Go build with
# the tags the Wails CLI would pass.
# -Run        launch the app after building
# -Shortcut   create/refresh Desktop and Start Menu shortcuts to the dev exe
# -Installer  also build <out>\RemtermSetup-<version>.exe to share with others
# -SkipEngine reuse the engine already in the output folder (faster UI/Go iterations)
# -Out        output folder (default build\bin)
param([switch]$Run, [switch]$Shortcut, [switch]$Installer, [switch]$SkipEngine, [string]$Version = '1.0.0', [string]$Out = 'build\bin')
$ErrorActionPreference = 'Stop'

function Invoke-Step([string]$what, [scriptblock]$cmd) {
    & $cmd
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

# gzip a file (the installer unpacks it); compresses the ~100 MB of exes to ~45 MB.
function Compress-Gzip([string]$src, [string]$dst) {
    $in = [IO.File]::OpenRead($src)
    try {
        $dstStream = [IO.File]::Create($dst)
        try {
            $gz = New-Object IO.Compression.GZipStream($dstStream, [IO.Compression.CompressionLevel]::Optimal)
            try { $in.CopyTo($gz) } finally { $gz.Dispose() }
        } finally { $dstStream.Dispose() }
    } finally { $in.Dispose() }
}

Push-Location $PSScriptRoot
try {
    Push-Location frontend
    if (-not (Test-Path node_modules)) { Invoke-Step 'npm install' { npm install } }
    Invoke-Step 'frontend build' { npm run build }
    Pop-Location

    # Icon, manifest and version info for the app and the installer
    # (regenerate after editing tools\appicon: delete the .syso files).
    if ($Installer -or -not (Test-Path rsrc_windows_amd64.syso) -or -not (Test-Path installer\rsrc_windows_amd64.syso)) {
        Invoke-Step 'resource generation' { go run ./tools/appicon $Version }
        Copy-Item build\windows\icon.ico rdp\engine\app.ico -Force
    }

    New-Item -ItemType Directory -Force $Out | Out-Null
    if (-not $SkipEngine -or -not (Test-Path $Out\RemtermRdp.exe)) {
        Invoke-Step 'RDP engine build' {
            dotnet publish rdp\engine\RemtermRdp.csproj -c Release -r win-x64 --self-contained true -nologo -v q `
                -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
                -p:DebugType=none -p:Version=$Version -o build\engine
        }
        Copy-Item build\engine\RemtermRdp.exe $Out\RemtermRdp.exe -Force
        Write-Host "Built $Out\RemtermRdp.exe" -ForegroundColor Green
    }

    Invoke-Step 'go build' { go build -tags desktop,production -trimpath -ldflags "-s -w -H windowsgui -X main.appVersion=$Version" -o $Out\Remterm.exe . }
    Write-Host "Built $Out\Remterm.exe" -ForegroundColor Green

    if ($Installer) {
        foreach ($exe in 'Remterm.exe', 'RemtermRdp.exe') {
            Compress-Gzip "$Out\$exe" "installer\payload\$exe.gz"
        }
        $setup = "$Out\RemtermSetup-$Version.exe"
        try {
            Invoke-Step 'installer build' { go build -trimpath -ldflags "-s -w -H windowsgui -X main.version=$Version" -o $setup ./installer }
        }
        finally {
            Remove-Item installer\payload\*.gz -ErrorAction SilentlyContinue
        }
        Write-Host "Built $setup ($([math]::Round((Get-Item $setup).Length / 1MB, 1)) MB)" -ForegroundColor Green
    }

    if ($Shortcut) {
        $exe = (Resolve-Path $Out\Remterm.exe).Path
        $shell = New-Object -ComObject WScript.Shell
        foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
            $lnk = $shell.CreateShortcut((Join-Path $dir 'Remterm.lnk'))
            $lnk.TargetPath = $exe
            $lnk.WorkingDirectory = Split-Path $exe
            $lnk.IconLocation = "$exe,0"
            $lnk.Description = 'Remterm - SSH, Remote Desktop and terminals'
            $lnk.Save()
            Write-Host "Shortcut: $(Join-Path $dir 'Remterm.lnk')" -ForegroundColor Green
        }
    }
    if ($Run) { Start-Process $Out\Remterm.exe }
}
finally {
    Pop-Location
}
