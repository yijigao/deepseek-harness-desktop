# Harness Lab MVP

Harness Lab is a local, read-only trajectory inspector. It compares two DeepSeek Harness runs without replaying them and without sending session data to an LLM or remote service.

## Canonical run

```json
{
  "runId": "opaque-local-id",
  "source": "deepseek-harness",
  "sourceVersion": "0",
  "startedAt": "2026-01-01T00:00:00.000Z",
  "endedAt": "2026-01-01T00:00:01.000Z",
  "durationMs": 1000,
  "model": "model-id",
  "workspace": "workspace-basename",
  "status": "success",
  "steps": [],
  "metrics": {}
}
```

Each canonical step contains `index`, `timestamp`, `type`, `tool`, a generic sanitized `summary`, `rawType`, `durationMs`, `success`, and sanitized `metadata`. Supported step types are `user`, `assistant`, `tool_call`, `tool_result`, `error`, `system`, and `unknown`.

## Metrics

| Metric | Deterministic definition |
|---|---|
| `total_steps` | Count of `step/end` events |
| `user_messages` / `assistant_messages` | Count of committed message events |
| `tool_calls` / `tool_results` | Count of tool call/result events |
| `failed_tool_calls` | Tool results with a structured error, `isError`, nonzero structured exit status, or a narrow process-failure marker |
| `unique_tools` | Distinct sanitized tool names used in tool calls |
| `repeated_tool_calls` | Repeated call occurrences beyond the first under the rule below |
| `duration_ms` | Header creation time to latest valid event time |
| `files_read` | Direct `read`, `read_image`, or editor-view calls; searches are not guessed as reads |
| `files_written` | Direct `write`, `edit`, patch, or editor mutation calls; shell side effects are not guessed |
| `shell_commands` | Direct `bash`, `pwsh`, or PowerShell tool calls |
| `failed_shell_commands` | Failed tool results paired to a shell call |
| `retry_count` | Exact `llm/retry` event count |
| `error_count` | Failed tool results plus explicit error events and terminal `turn/end` error reasons |
| token metrics | Sum reported upstream usage; `null` when absent |

### Repeated tool-call heuristic

The parser canonicalizes the tool's arguments by sorting object keys, redacting secret-valued keys and secret-shaped strings, and dropping volatile call ids, request ids, timestamps, nonces, and timeout fields. It immediately hashes `tool + canonical arguments`; raw arguments and path strings are not retained.

A call is a repeat when an equal signature occurs among the previous five tool calls and, when both timestamps exist, within 120 seconds. Each occurrence after the first increments `repeated_tool_calls`. A `repeated_tool_loop` divergence requires at least three matching occurrences in that window. This rule is deterministic and intentionally does not judge semantic intent.

## Divergence rules

- `repeated_tool_loop`: one run has a group of at least three equal short-window calls and the other does not have an equal-or-larger group.
- `extra_failed_command`: one run has more failed shell results.
- `unnecessary_file_churn`: one run has at least two more direct file-write calls.
- `extra_search_read_path`: one run has at least two more direct search/read calls.
- `test_execution_timing`: both runs execute a recognized test command, but at different tool-call ordinals.
- `failure_recovery`: a failed shell signature is followed by a successful result for the same signature.
- `unrecovered_failure`: a run has failed shell results without a later success for the same signature.

Recognized test runners are a fixed command-name set (npm/pnpm/yarn/bun test, pytest, Vitest, Jest, Cargo, Go, .NET, Maven, and Gradle). Command text is inspected in the main process and discarded; it is not sent to the UI.

## Desktop security and privacy

The Harness workspace and Harness Lab use separate BrowserWindows. Harness Lab loads local static assets under a restrictive Content Security Policy. Its renderer has `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.

Only these preload methods are exposed:

```text
window.harnessLab.listRuns()
window.harnessLab.getRun(id)
window.harnessLab.compareRuns(a, b)
```

All filesystem reads happen in the main process. Run ids are opaque entries in a main-process registry, not paths. The renderer cannot pass a path, import Node modules, execute a process, navigate away, open another window, or request permissions.

Message content, raw tool results, tool arguments, command text, source session ids, and absolute paths are excluded from renderer payloads. Unknown-event string values are omitted rather than treated as display text. Workspace and file references are basenames only. Prompt comparison is not part of this MVP.

## Known limitations

- No Replay, Fork, Time Machine, LLM analysis, multi-model adapter, sync, telemetry, or database.
- Packed assistant delta rows are not expanded because the MVP does not reconstruct replay text.
- Tool categorization recognizes the current upstream built-in names; plugin tool side effects remain `other` unless a future adapter declares them.
- Status is conservative and may be `unknown` when no recognized terminal turn reason exists.
- Session discovery is capped at the 100 most recent readable artifacts and files over 256 MiB are skipped.
- Real user-session compatibility remains unvalidated; see the session format audit.
