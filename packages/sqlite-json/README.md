# Transactional chunked JSON

Shared synchronous persistence helper for the session runtime and harnesses. It has no network I/O, background cleanup, or transaction ownership. Callers use their own namespace-specific table and **must** write/delete the owning row and its chunks within the same `transactionSync`/harness transaction.

- JSON up to 256 KiB UTF-8 stays inline in the owning text column.
- Larger JSON becomes a short `@sqlite-json:1:<uuid>:<part-count>:<byte-count>` manifest. The prefix is not valid JSON, so user values cannot impersonate references.
- Chunk rows are `(payload_id, part, content)`. Text is split at at most 65,536 UTF-16 code units without splitting surrogate pairs; each row's content is at most 192 KiB UTF-8.
- Reads verify consecutive parts, expected count and total bytes before reconstructing JSON. Missing or malformed chunks throw; incomplete payloads are never silently returned.
- Each manifest belongs to exactly one field. Do not share references. Replacing/deleting that field requires `deleteJson` in the same transaction. Retained payloads need no GC; future retention work must delete their chunks too.
- Public operation input/outcome limits are 8 MiB in `contracts`. The helper allows 10 MiB internally for containing inbox envelopes, not as an additional public allowance. It materializes one bounded payload in memory; it is not a streaming API.

Use `jsonChunksSchema(tableName)` in a versioned migration. The runtime owns `runtime_json_chunks`; minimal-bash owns `minimal_bash_json_chunks`. The runtime deletes request chunks at acceptance or terminal completion, while outcome/inbox and transcript chunks remain retained under existing policies.

Existing small inline JSON is still readable. The new runtime/harness migrations only add chunk tables and do not rewrite previous payloads. A deployed app containing an older runtime cannot interpret new manifests or downgrade migration history; deploy all participating Workers together before sending larger payloads.

`pnpm --filter @managed-agents/sqlite-json check` covers UTF-8 boundaries, inline/reference disambiguation, independent deletion, corruption and transaction rollback. Workerd integration coverage lives in the runtime and minimal-bash host tests.
