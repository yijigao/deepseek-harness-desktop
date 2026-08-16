# DeepSeek Harness session format audit

Audit date: 2026-08-16

> Schema-derived and synthetic-validated. Real-world session compatibility has not yet been validated against a local user session.

## Scope and evidence boundary

No readable user session was available in the audit environment. The default DSH home was not populated, `DSH_HOME` did not identify another readable home, and no installed runtime supplied additional local session samples. No user prompt, tool output, credential, or session text was copied into this repository.

The MVP baseline therefore comes from the current `master` branch of the official [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) source and from synthetic fixtures only. The relevant upstream contracts are:

- [`home-paths`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/home-paths/src/index.ts): `DSH_HOME`, default home, and symbolic display rules.
- [base bundle configuration](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/base/cordis.patch.yml): the shipped JSONL backend root.
- [JSONL persistence README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/README.md) and [`format.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/src/format.ts): layout, compression, header, and storage rows.
- [`SessionEvent` types](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/types.ts) and [known event catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/src/known-event-types.ts): the event envelope and vocabulary.
- [LLM types](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm/src/types.ts): token usage and streaming usage chunks.

## Storage location and files

The upstream home resolver uses `DSH_HOME` when set and otherwise resolves the operating-system home plus `.dsh`. On Windows, the default symbolic location is `%USERPROFILE%\.dsh`. The shipped base bundle configures the session root as:

```text
<DSH_HOME>/sessions
```

The current project/session layout is:

```text
<sessions-root>/
  --<normalized-cwd>--/       # or _no-cwd/
    <encoded-session-id>/
      session.jsonl.zstd      # default
      session.jsonl           # compression: none only
```

Discovery must use the fixed transcript names and must not interpret a directory name as a session id. The desktop scanner does not follow symbolic links, caps discovery, and never gives paths to the renderer.

The default `.zstd` artifact is a concatenation of independent, checksummed Zstandard frames: one header frame followed by append frames. The logical content is still newline-delimited JSON. Plain `.jsonl` uses the same logical records.

The desktop targets Electron 43, whose main process embeds Node 24.17 or newer ([Electron 43 stack](https://www.electronjs.org/blog/electron-43-0)); Node exposes synchronous Zstandard decoding from 22.15 onward ([Node zlib API](https://nodejs.org/api/zlib.html#zlibzstddecompresssyncbuffer-options)). The scanner also treats a missing decoder as an explicit run-list error instead of silently omitting default-format sessions.

## First logical line: session header

The first logical line is not a `SessionEvent`. It is a tagged immutable header:

| Field | Shape | Meaning |
|---|---|---|
| `type` | `"session"` | Header discriminator |
| `version` | integer | On-disk format version; currently `0` |
| `id` | string | Source session id |
| `createdAt` | integer | Unix epoch milliseconds |
| `cwd` | string, optional | Absolute workspace at creation |
| `parentSession` | string, optional | Fork/seed lineage |
| `seedLength` | integer, optional | Inherited event prefix length |
| `origin` | `"subagent"`, optional | Coarse child classification |
| `delegationDepth` | integer | `0` for a top-level session |
| `agentPreset` | string, optional | Preset used to compose the session |

Harness Lab hashes the storage path into an opaque registry id instead of exposing the source session id. It reduces `cwd` to its basename before normalization or display.

## Subsequent logical lines: event envelope

An ordinary event has this envelope:

```json
{
  "type": "event/type",
  "seq": 0,
  "time": 0,
  "data": {},
  "ignorable": true,
  "sourceEventSeqs": [],
  "surfaceOp": "append"
}
```

Only `type`, `seq`, `time`, and `data` are the common event fields. `time` is Unix epoch milliseconds. `ignorable`, `sourceEventSeqs`, and `surfaceOp` are conditional metadata. Unknown ordinary event types may be added without a format-version bump; upstream readers use `ignorable` to decide whether an unknown event is safe to skip. Harness Lab is an inspector, not a replay engine, so its tolerant adapter retains a sanitized `rawType`/metadata record and continues even when an unknown event is not marked ignorable.

Packed storage rows (`text-chunks`, `reasoning-chunks`, and `tool-call-chunks`) may replace eligible runs of assistant delta events. They are storage codec rows, not ordinary event types. The MVP ignores these high-volume delta rows because the requested run metrics use committed messages, tool events, lifecycle boundaries, retries, and usage events. It does not attempt full replay reconstruction.

## Fields available for Harness Diff

| Requested fact | Upstream source | MVP handling |
|---|---|---|
| User message | `user/message.data` | Counted; content never normalized or displayed |
| Assistant message | `assistant/message.data.message` | Counted; content never normalized or displayed |
| Tool call | `tool/call.data.{callId,name,arguments}` | Name/category retained; arguments parsed only to derive a redacted hash and basenames |
| Tool result | `tool/result.data.message`, optional `data.error` | Counted; result content discarded; structured failure retained as a boolean |
| Token usage | `assistant/message.data.usage` or `assistant/chunk.data.chunk` with `type: "usage"` | Summed when present; otherwise `null` / N/A |
| Model | `request/header.data.header.config.model` or `assistant/message.data.message.source.model` | First available sanitized model id |
| Timestamp | Header `createdAt`; event `time` | Converted to ISO timestamps |
| Workspace | Header `cwd` | Basename only |
| Session id | Header `id` | Never exposed; replaced by an opaque local id |
| Error | `turn/end.data.reason.kind`, `tool/result.data.error`, or result error markers | Reduced to run status and failure counts |
| Status | Latest `turn/end.data.reason.kind` | `completed` => success; known terminal failure kinds => failed; otherwise unknown |

`TokenUsage.inputTokens` is upstream's uncached-input count. Cache reads/writes are separate optional fields. The MVP reports `input_tokens` from `inputTokens`, `output_tokens` from `outputTokens`, and their sum as `total_tokens`; it does not guess or fold cache counters into those names.

## Stable discriminators and lifecycle markers

The official event map provides stable `type` discriminators such as:

- `turn/start`, `turn/end`
- `step/start`, `step/end`
- `user/message`, `assistant/chunk`, `assistant/message`
- `tool/call`, `tool/result`
- `request/header`, `request/context`
- `llm/retry`, `llm/retry-started`
- `command/run`, `command/done`
- `session/end-seed`

Message roles live inside the typed message objects. Tool names live at `tool/call.data.name`; a tool result is paired by call id. There is no single global session-end record. `turn/end` ends a turn. `session/end-seed` marks the boundary after an imported/resumed seed and must not be treated as the end of the session.

## Version and compatibility risk

`SESSION_FORMAT_VERSION` is currently `0`. Upstream explicitly describes the format as pre-release: broad compatibility is not implied, incompatible logs may be rejected, and no general migration is provided. Fields or behaviors most likely to vary are:

- ordinary event vocabulary and plugin-defined event data;
- optional header fields and turn-end reason variants;
- packed storage-row encoding;
- message/provider attribution details;
- tool-specific `meta` payloads and result presentation;
- physical compression/layout configuration.

For that reason, Harness Lab does not hard-code one workspace directory name or assume every record is a known event. File discovery accepts both current fixed suffixes, the adapter checks the tagged header when present, malformed lines become diagnostics, missing fields become unknowns, and all unknown metadata passes through privacy sanitization.

## Privacy boundary

The normalized trajectory deliberately excludes message bodies, system prompts, tool output, shell command text, and raw tool arguments. Secret-like keys are replaced before metadata leaves the parser. Common credential-shaped strings and credential-bearing URL userinfo are redacted. File paths become basenames. The renderer receives only canonical safe fields through a strict main-process registry API; it never receives a filesystem path.
