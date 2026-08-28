# DeepSeek Harness Desktop v1.4.0

This release makes Harness Lab faster, fully Chinese, and action-oriented.

## Performance

- Reduces initial discovery from 100 sessions to the 20 most recent sessions.
- Persists sanitized summary metadata and reuses it while source file identity is unchanged.
- Defers full trajectory loading until a run is actually compared.

## Chinese interface

- Translates all visible navigation, table, state, metric, divergence, empty-state, and feedback copy.
- Translates deterministic divergence explanations and severity labels.

## Actions

- **Copy optimization task** creates a ready-to-paste DSH follow-up task from the diagnosis.
- **Export comparison report** writes a local Markdown report with findings and next steps.
- **Set better run as baseline** persists the selected winner and automatically preselects it for future comparisons.

All analysis, caching, baseline state, clipboard actions, and reports remain local.
