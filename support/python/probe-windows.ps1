$ErrorActionPreference = "SilentlyContinue"

$probeArchitecture = switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { "x86_64" }
  "ARM64" { "aarch64" }
  default { "unknown" }
}

$probeFacts = [ordered]@{
  os = "windows"
  architecture = $probeArchitecture
  capabilities = @{}
}

$probePythonCommand = "py"
$probePythonOutput = & py -3 --version 2>&1
if (-not $?) {
  $probePythonCommand = "python"
  $probePythonOutput = & python --version 2>&1
}
if ("$probePythonOutput" -match "Python\s+(\d+\.\d+\.\d+)") {
  $probeFacts.python = [ordered]@{
    command = $probePythonCommand
    version = $Matches[1]
  }
}

$probeFacts | ConvertTo-Json -Depth 3
