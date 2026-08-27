# DeepSeek Harness Desktop v1.3.0

This release turns model setup and runtime diagnosis into a first-class desktop workflow.

## Highlights

- New **Models & Health** window available from the desktop title bar.
- At-a-glance status for the desktop version, bundled DSH runtime, local server, `settings.yaml`, OAuth credentials, and adapter compatibility.
- One-click ChatGPT subscription OAuth login using the bundled local runtime.
- One-click access to `DSH_HOME` for advanced provider configuration.
- OAuth credentials remain local and are never returned to the renderer; only account and expiry metadata are shown.
- ChatGPT OAuth login, test, and compatibility tools are now included in packaged builds.

## Existing v1.2 features

Harness Lab continues to provide local, sanitized run comparison for tool calls, failures, retries, file churn, test timing, and recovery behavior.

## Notes

- ChatGPT subscription access uses the `openai-codex` OAuth route and depends on compatibility with the bundled `dsh-llm-pi-ai` adapter.
- Custom OpenAI-compatible providers are still configured through `$DSH_HOME/settings.yaml`; the health window opens that directory directly.
- This is a community-maintained project and is not an official DeepSeek desktop client.
