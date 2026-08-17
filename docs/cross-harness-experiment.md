# Controlled cross-harness experiment

Status: **prepared, not executed**.

This document records the frozen experiment setup and the infrastructure blockers. It does not present synthetic data as a real harness result.

## Fixture

An independent temporary Git repository named `harness-cross-smoke` was created outside this project. Initial commit:

```text
de597dad50a8c2def22bb3020b0dd7be9feff22f
```

It contains `calculator.py`, `test_calculator.py`, and `TASK.md`. `divide(a, b)` incorrectly multiplies, while unrelated add, subtract, and multiply functions pass. The frozen baseline produces one passing test and one failing test (`16 != 4`).

Two clean clones were created for the DeepSeek Harness and Codex arms. Both resolved to the exact initial commit above and both had empty working-tree status.

## Frozen prompt

```text
There is a failing test in this repository.

Find the root cause, make the smallest correct fix, run the relevant tests,
and stop when the tests pass.

Do not add dependencies.
Do not modify unrelated files.
```

## Execution blockers

- DeepSeek Harness is not installed in the execution environment and no local DSH session store is present.
- Project rules prohibit a running Codex session from invoking `codex`, `codex exec`, a profile wrapper, or any nested Codex session. The controlled Codex arm therefore requires the user to run the frozen prompt from an independent terminal.
- The environment has no mounted Windows user profile and no Windows/Wine runtime, so the packaged Windows UI smoke cannot be performed here.

No harness arm was run, so there is no success/failure result, metric table, divergence result, or screenshot. `SAME_INITIAL_COMMIT` and `SAME_PROMPT` are prepared controls, not claims that the experiment completed. No rerun or result selection occurred.

When those prerequisites are available, each arm must run exactly once from its clean clone. A rerun is permitted only for a separately recorded infrastructure failure. The resulting local traces can then be imported, compared, privacy-checked, and captured without committing either raw trace.
