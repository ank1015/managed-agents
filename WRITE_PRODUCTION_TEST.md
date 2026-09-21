# Write worker production deployment and test — 2026-09-21

## Result

**All 16 write scenarios passed on the benchmark Mac.** Eleven returned successful
write receipts, four returned expected filesystem tool errors, and one oversized
input completed locally without a gateway job. All 15 gateway jobs delivered their
initial signed callbacks with HTTP 204 on the first attempt. Deliberate redelivery
also returned 204 and produced no duplicate session result.

Terminal replay of an earlier write preserved a later write's bytes and modification
time. Terminal replay of the exact 5 MiB write also passed with the gateway's retained
request included in job detail. The existing production bash harness passed a fresh
LLM → bash → LLM regression through the updated callback router.

## Deployment

| Service | Final deployed version |
| --- | --- |
| `managed-agents-tool-pi-write` | `395e184a-9974-45e1-9144-620daca59898` |
| `managed-agents-execution-gateway-callback` | `0f5d7e49-968a-4981-a923-b349f541001b` |
| Private test host `managed-agents-write-smoke` | `bc712f37-800b-4ffe-9c9b-3c0e786e1b2d` |

The tested write version was `1ee8b2d9-b81d-4e37-95f4-e12a2f0a898e` with a temporary
binding to the test session namespace. The final deployment uses the same code,
gateway credential and execution settings, with that temporary binding removed and
`SESSION_ROUTES: "{}"`. Public Workers.dev and preview URLs are disabled. The router
retains its new private `WRITE_EVENTS → PiWriteCallbacks` binding alongside bash/read.
A future harness must configure its session namespace and private submit binding.

Existing production services were verified unchanged:

- Read: `d6611b28-628a-49d9-8f32-58b71457824c`.
- Bash: `a723b96c-0b24-4cf3-85b7-6671175c257a`.
- Minimal bash v7: `eecc1311-281b-4297-85f5-e245482fdfaf`.

The write worker uses a dedicated named execution-gateway user API key. Existing
keys, callback URL, signing secret, and machine registration were preserved.

## Machine and test path

- Machine: `75fc68a7-de9f-451f-ae21-292aa86ad032` (`ank-mac`), the same Mac used by the v7 benchmark.
- Runtime generation: `10567cba-aaad-4c4a-b226-078ed3c42e76`; protocol 4, `filesystem.overwrite: true`.
- The user updated and restarted the daemon before testing. No further restart was needed.
- Test window: `2026-09-21T08:14:50.918Z` to `2026-09-21T08:16:59.453Z`.
- All file mutations were confined to `/var/folders/1n/t7lbn2t179zg_xjbmn62ypmr0000gn/T/pi-write-production-5r132stc/files`.
- The benchmark project's files were untouched.

The temporary authenticated test host used the real `SessionDriver`, Durable Object
SQLite and private submit RPC. The complete path was:

```text
Test session DO → PiWrite → execution gateway → Mac filesystem
                 ↑                              ↓
Test session DO ← PiWriteCallbacks ← signed callback router
```

Large-input fixtures were reconstructed from small deterministic test configuration
inside the test harness. This exercised real 5 MiB private RPC and gateway submission
without storing a 5 MiB configuration in one SQLite row. The production harness still
exposes only bash; this was not an LLM-generated write tool turn.

## Scenarios

| Scenario | Result |
| --- | --- |
| create nested file, spaces, UTF-8, NUL and CRLF | Passed; bytes/hash verified |
| overwrite shorter content removes old tail | Passed; bytes/hash verified |
| absolute path and empty overwrite | Passed; bytes/hash verified |
| empty new file | Passed; bytes/hash verified |
| identical contents returns already_applied | Passed; bytes/hash verified |
| replace existing file larger than 5 MiB | Passed; bytes/hash verified |
| write through symlink | Passed; bytes/hash verified |
| dangling symlink creates target and parents | Passed; bytes/hash verified |
| atomic replacement leaves other hard links intact | Passed; bytes/hash verified |
| literal tilde and at-sign paths | Passed; bytes/hash verified |
| directory is a tool error | Expected filesystem tool error |
| parent file is a tool error | Expected filesystem tool error |
| permission denied is a tool error | Expected filesystem tool error |
| symlink loop is a tool error | Expected filesystem tool error |
| exact 5 MiB UTF-8 write | Passed; bytes/hash verified |
| above 5 MiB completes locally and preserves destination | Completed tool error; no gateway job |

Every successful write was independently read from this Mac and compared byte for
byte with the requested UTF-8 content. Returned SHA-256 and byte counts were checked.
The oversized test verified that its existing destination still contained `keep me`
and that the corresponding gateway idempotency key had no job.

## Replay and delivery verification

- Earlier-write replay: returned the original job/result while preserving the later contents.
- Manual callback redelivery: one admitted completion and one consumed result, with no file change.
- Exact 5 MiB replay: completed successfully despite job detail containing the retained base64 input.
- Final snapshots: all 16 test operations finished, no pending operations or blocked test sessions.
- Existing bash regression: session `ses_015b59e6-315a-446f-994d-7b23ec14735d` completed idle with marker `WRITE_DEPLOY_BASH_ROUTE_OK`; its callback returned 204.

During preflight, the new retained-request field exposed a too-small terminal replay
response budget in the adapter. The bounded detail budget was raised to 18 MiB and
the fake gateway updated to include retained requests. Worker typechecks, tests and
deployment dry run passed after the fix; live 5 MiB replay verified it.

The temporary Workers.dev endpoint initially returned 404 during activation
propagation. Testing started only after unauthenticated access correctly returned 401;
no write job had been submitted during that readiness delay.

## Cleanup and limits

- Temporary test endpoint and previews disabled; its bearer-token secret revoked.
- Temporary session route and namespace binding removed from the write worker.
- Plaintext execution-key and smoke-token files removed from local evidence.
- Private test DO history and benign fixture files retained for inspection.
- No production fault injection, load benchmark, or crash/restart guarantee was tested.
- The worker's 5 MiB file cap does not increase the existing 1,900,000-byte LLM outcome
  or inline session-history limits.

Local evidence is in `/var/folders/1n/t7lbn2t179zg_xjbmn62ypmr0000gn/T/pi-write-production-5r132stc`: `write-report.json`, `verification.json`,
`bash-regression.json`, before/tested/final audits, deployment logs and replay scripts.
The helper scripts refer to removed secret files; credentials are not embedded in them.
