$ErrorActionPreference = 'Stop'
$candidateRoot = 'C:\Users\yi\Documents\Codex\harness-alpha2-validation-20260908'
$reportRoot = 'C:\Users\yi\Documents\Codex\deepseek-harness-desktop\dist-validation-symlink'
New-Item -ItemType Directory -Path $reportRoot -Force | Out-Null
Set-Location -LiteralPath $candidateRoot
$ErrorActionPreference = 'Continue'
& 'C:\Program Files\nodejs\node.exe' '.\node_modules\vitest\vitest.mjs' run --maxWorkers=1 'packages/session/session-persistence-jsonl/tests/generation.spec.ts' -t 'fails loud without altering a colliding symlink target' *> (Join-Path $reportRoot 'test.log')
$testExit = $LASTEXITCODE
[System.IO.File]::WriteAllText((Join-Path $reportRoot 'exit-code.txt'), [string]$testExit)
exit $testExit
