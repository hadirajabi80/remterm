# Builds Termora without the Wails CLI: frontend bundle, then a Go build
# with the tags the CLI would pass.
# -Run        launch the app after building
# -Shortcut   create/refresh Desktop and Start Menu shortcuts to the dev exe
# -Installer  also build build\bin\TermoraSetup-<version>.exe to share with others
param([switch]$Run, [switch]$Shortcut, [switch]$Installer, [string]$Version = '0.1.0')
$ErrorActionPreference = 'Stop'

function Invoke-Step([string]$what, [scriptblock]$cmd) {
    & $cmd
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

Push-Location $PSScriptRoot
try {
    Push-Location frontend
    if (-not (Test-Path node_modules)) { Invoke-Step 'npm install' { npm install } }
    Invoke-Step 'frontend build' { npm run build }
    Pop-Location

    # Icon, manifest and version info for the app and the installer
    # (regenerate after editing tools\appicon: delete the .syso files).
    if (-not (Test-Path rsrc_windows_amd64.syso) -or -not (Test-Path installer\rsrc_windows_amd64.syso)) {
        Invoke-Step 'resource generation' { go run ./tools/appicon }
    }

    New-Item -ItemType Directory -Force build\bin | Out-Null
    Invoke-Step 'go build' { go build -tags desktop,production -trimpath -ldflags "-s -w -H windowsgui" -o build\bin\Termora.exe . }
    Write-Host "Built build\bin\Termora.exe" -ForegroundColor Green

    if ($Installer) {
        Copy-Item build\bin\Termora.exe installer\payload\Termora.exe -Force
        $setup = "build\bin\TermoraSetup-$Version.exe"
        try {
            Invoke-Step 'installer build' { go build -trimpath -ldflags "-s -w -H windowsgui -X main.version=$Version" -o $setup ./installer }
        }
        finally {
            Remove-Item installer\payload\Termora.exe -ErrorAction SilentlyContinue
        }
        Write-Host "Built $setup ($([math]::Round((Get-Item $setup).Length / 1MB, 1)) MB)" -ForegroundColor Green
    }

    if ($Shortcut) {
        $exe = (Resolve-Path build\bin\Termora.exe).Path
        $shell = New-Object -ComObject WScript.Shell
        foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
            $lnk = $shell.CreateShortcut((Join-Path $dir 'Termora.lnk'))
            $lnk.TargetPath = $exe
            $lnk.WorkingDirectory = Split-Path $exe
            $lnk.IconLocation = "$exe,0"
            $lnk.Description = 'Termora SSH workspace'
            $lnk.Save()
            Write-Host "Shortcut: $(Join-Path $dir 'Termora.lnk')" -ForegroundColor Green
        }
    }
    if ($Run) { Start-Process build\bin\Termora.exe }
}
finally {
    Pop-Location
}
