# Diagnostics

Small synchronous structured logger shared by the API, host/runtime and operation adapters. Uses only `console`: no logging HTTP requests, queues, database reads/writes, persistent buffers or added request IDs.

## Production defaults

- Automatic invocation logs are disabled in all five Wrangler configurations (and the host bootstrap configuration).
- Cloudflare head sampling remains 100% so deliberately emitted failures are not randomly discarded.
- Success summaries are selected by a stable hash of the session ID, at 1% by default. All services select the same sessions when configured with the same rate.
- Errors and runtime retry decisions are emitted without sampling.
- Unauthenticated rejection warnings have a fixed 1% per-request sample, including in debug mode. This reduces volume, but is not a hard rate limit.
- Successful API reads/input admissions, duplicate completions and ordinary command nonzero exits have no custom event.

## Per-service settings

Set non-secret Wrangler vars, then redeploy that service:

| Variable | Default | Behavior |
|---|---|---|
| `LOG_SUCCESS_SAMPLE_RATE` | `"0.01"` | Fraction from 0 to 1; `"0"` disables success summaries, `"1"` emits all. Invalid values fall back to 1%. |
| `LOG_DEBUG` | unset/false | Exact string `"true"` emits all available success summaries, still without payloads. Does not enable automatic invocation logs or log every internal step. |

New harnesses/tools may add meaningful events or temporarily enable invocation logs in their own configuration. Do not increase global verbosity to debug one service. Diagnostic settings must not come from untrusted session input.

## Event ownership

| Owner | Events |
|---|---|
| API | `request_failed` for 5xx; sampled `request_unauthorized`; sampled `session_created` |
| Runtime/host | `transition_failed`, `processing_blocked`, `processing_unavailable`, `processing_retry_scheduled`, `run_failed`, `status_publish_failed`; sampled harness status changes |
| LLM/bash adapter | `submission_rejected`, `submission_failed`, `operation_failed`; sampled submission/completion summaries |
| LLM webhook / execution router | `callback_failed`, `callback_invalid` for authenticated malformed events; sampled `callback_unauthorized` |

Lower-level gateway clients do not print exceptions. The adapter logs submission outcomes, while the runtime records the separate decision to retry/block. Callback delivery failures are logged once at the outer HTTP owner (LLM webhook or execution router), not again at every service hop. Failed upstream operations and a resulting failed harness run are distinct events. Ordinary cancellations and tool exit failures are not infrastructure errors.

## Privacy and reliability

Log only developer-controlled event names, stage names and fixed error codes. The logger projects a bounded allowlist of fields; it never spreads arbitrary caller objects into a record. Supported fields are stage, session/operation/job identifiers, errorCode, outcome, retryable, blocked, attempt, durationMs and httpStatus. Existing runtime operation IDs are preserved; arbitrary strings are not accepted as correlation IDs.

Never pass prompts, command strings, tool output, headers, config, full URLs, credentials, Error objects/messages/stacks or upstream error bodies. Metadata logs are not an audit ledger. The platform may independently report uncaught exceptions; this package governs explicit application events, not Cloudflare's own exception machinery.

Console-sink failure is best-effort and cannot change application behavior. Telemetry delivery is not guaranteed by the application. Logging adds no recovery mechanism and does not alter callback acknowledgements, idempotency or transactional processing.

## Rollout and measurement

Deploy only after failure/redaction tests and Worker dry-runs pass. No schema/namespace changes are required for this logging-only update. Verify deployed settings, run a read-only real LLM → bash → LLM smoke, and check both transcript and live-tail errors.

Do not reuse invocation counts as an ingestion estimate after this change: live tail can show invocation metadata even when invocation-log persistence is disabled. Measure persisted events after rollout. Savings depend on errors, sampling and account allowances; no measured savings claim follows merely from changing the configuration.
