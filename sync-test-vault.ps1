$ErrorActionPreference = "Stop"

$pluginDir = Join-Path $PSScriptRoot "test-vault\.obsidian\plugins\better-links"

New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null

Copy-Item (Join-Path $PSScriptRoot "main.js") $pluginDir -Force
Copy-Item (Join-Path $PSScriptRoot "manifest.json") $pluginDir -Force
Copy-Item (Join-Path $PSScriptRoot "versions.json") $pluginDir -Force

Write-Output "Synced plugin files to $pluginDir"
