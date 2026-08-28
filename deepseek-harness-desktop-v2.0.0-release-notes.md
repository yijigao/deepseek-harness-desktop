# DeepSeek Harness Desktop v2.0.0

Harness Lab is rebuilt around task reliability instead of arbitrary run comparison.

## Task health first

- Every run can be inspected independently for execution completion, detected validation, failures, retries, repeated calls, and unrecovered commands.
- Execution completion and business acceptance are shown as separate gates. The app no longer implies that a successful process proves the business result is correct.
- A ready-to-paste repair task turns findings into a concrete continuation workflow.

## Traceability

- Run health identifies the local project, model, and exact time.
- **Open original conversation** attempts to locate the source session in the main DSH workspace while keeping the raw session id inside the Electron main process.

## Controlled experiments

- Historical runs can no longer be compared arbitrarily.
- Comparison is permitted only for attempts in the same DSH session lineage, such as a root run and its fork or sibling attempts sharing a parent.
- Outcome state is evaluated before trajectory efficiency.

## Privacy

- Source session ids and parent ids remain private to the main process.
- The renderer receives only opaque lineage identifiers and sanitized task metadata.
