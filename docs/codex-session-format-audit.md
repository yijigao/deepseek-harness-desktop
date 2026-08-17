# Codex session format audit

This audit was derived from local Codex JSONL artifacts, not from an online schema description. The inspected installation stored 107 session files under:

```text
<home>/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
```

On Windows, Harness Lab resolves the equivalent fixed root from the Electron process home directory:

```text
%USERPROFILE%\.codex\sessions
```

The audit environment did not expose a mounted Windows user profile, so the Windows path could not be independently observed there. The adapter was real-session parsed against the available local Codex store. No real trace or trace content is committed.

## JSONL envelope

Each non-empty line is a JSON object with an outer `type`, an ISO timestamp on most records, and a type-specific `payload`. No explicit per-file schema version was observed. `session_meta.cli_version` is retained as the safe source version; it is not treated as a schema contract.

Observed outer and nested shapes included:

| Outer type | Observed nested type or role | Canonical mapping |
| --- | --- | --- |
| `session_meta` | metadata payload | `system` |
| `turn_context` | runtime metadata | `system` |
| `response_item` | `message` | `user`, `assistant`, or `system` by role |
| `response_item` | `function_call`, `custom_tool_call` | `tool_call` |
| `response_item` | `function_call_output`, `custom_tool_call_output` | `tool_result` |
| `response_item` | `reasoning` | `system`; content omitted |
| `event_msg` | `task_started`, `task_complete` | `system` lifecycle |
| `event_msg` | `token_count` | `system` with safe cumulative usage |
| `event_msg` | user/agent messages | `user` / `assistant`; content omitted |
| unknown | any | `unknown` with sanitized structural metadata |

Other observed event names included `agent_reasoning`, `patch_apply_end`, `sub_agent_activity`, `mcp_tool_call_end`, `web_search_end`, `thread_settings_applied`, `context_compacted`, `world_state`, `compacted`, and inter-agent metadata. Unknown events remain parseable and retain only a safe `rawType` plus sanitized structure.

## Field findings

Stable enough for this adapter:

- outer `type` plus a type-specific `payload`;
- ISO `timestamp` on the envelope for ordering and duration;
- `response_item.payload.type` for messages and tool call/result pairing;
- `call_id` for tool pairing, stored only as a short hash internally;
- `turn_context.payload.model` and `cwd`;
- `session_meta.payload.cli_version`;
- cumulative token usage under `event_msg.payload.info.total_token_usage` when present.

Optional or version-dependent:

- `session_meta`, `turn_context`, `task_started`, and `task_complete`;
- model, effort, workspace roots, Git metadata, source metadata, duration, tool namespace, call status, and token usage;
- `function_call` versus `custom_tool_call` wrappers;
- token subfields such as cached or reasoning tokens;
- terminal status. A missing terminal event produces `unknown`, not an inferred success.

Unknown:

- whether event names and payload details are a public compatibility contract;
- whether cumulative token counters have identical semantics across Codex versions;
- a single authoritative session-end marker for interrupted or externally terminated runs;
- whether every file operation appears as a dedicated tool rather than a shell command.

## Privacy classification

Sensitive fields observed or structurally possible include:

- source session and turn IDs;
- raw user, assistant, developer, and reasoning content;
- tool arguments, commands, inputs, outputs, stdout, stderr, and errors;
- full cwd and workspace roots;
- Git remote and local workspace metadata;
- environment, permission, authentication, connector, and request metadata;
- tool payloads that may contain credentials or source code.

The renderer receives none of those raw values. The adapter emits an opaque run ID, a sanitized workspace basename, safe model/tool labels, canonical tool categories, aggregate metrics, generic summaries, safe `rawType` values, and structurally sanitized unknown metadata. Secret-key and credential-shape redaction covers `api_key`, `apikey`, `token`, `authorization`, `password`, `secret`, `cookie`, `session_token`, `access_token`, `sk-*`, `Bearer *`, `ghp_*`, and `github_pat_*`.

## Validation performed

- Synthetic fixtures reproduce the observed envelope families and include malformed, missing, unknown, secret-bearing, and absolute-path cases.
- A current real local Codex JSONL parsed as `source=codex` with model, sanitized workspace basename, lifecycle, tool calls, and zero malformed lines.
- The public renderer payload did not contain a known prompt marker, an absolute workspace path, or a source-session-ID key.

This is a best-effort importer for observed local artifacts, not a claim that Codex exposes a frozen public trace schema.
