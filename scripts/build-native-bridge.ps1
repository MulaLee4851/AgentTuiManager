$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$frameworkRoots = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319')
)
$framework = $frameworkRoots | Where-Object { Test-Path (Join-Path $_ 'csc.exe') } | Select-Object -First 1
if (-not $framework) { throw 'The Windows .NET Framework C# compiler is required.' }

$source = Join-Path $projectRoot 'native\AgentTui.NativeBridge\Program.cs'
$output = Join-Path $projectRoot 'build\native'
New-Item -ItemType Directory -Path $output -Force | Out-Null

$reference = '/reference:' + (Join-Path $framework 'System.Web.Extensions.dll')
$automationClient = '/reference:' + (Join-Path $framework 'WPF\UIAutomationClient.dll')
$automationTypes = '/reference:' + (Join-Path $framework 'WPF\UIAutomationTypes.dll')
$outputArgument = '/out:' + (Join-Path $output 'AgentTui.NativeBridge.exe')
& (Join-Path $framework 'csc.exe') /nologo /target:exe /optimize+ /platform:anycpu `
  $reference $automationClient $automationTypes $outputArgument $source
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
