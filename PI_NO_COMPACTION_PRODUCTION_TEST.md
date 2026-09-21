# Pi no-compaction production verification

Date: 2026-09-21. Status: deployed; all four complete live runs passed (19 checks per run, 76 total).

## Deployment

Harness `pi-no-compaction/v1`, route `pi-no-compaction-v1`, Worker
`managed-agents-harness-pi-no-compaction-v1`, SQLite DO class
`PiNoCompactionSessionV1`, namespace `834f74ab08a14eabbd4052a4fbca3998`.

The host was bootstrapped, all five operation workers redeployed, the full host
activated, and agent-api deployed last. The final Cloudflare audit confirmed
matching namespace bindings and disabled workers.dev/preview URLs. Existing
minimal-bash bindings, callback router, credentials, and D1 database were retained.
Current version IDs are recorded in [DEPLOYMENT.md](DEPLOYMENT.md).

## Live test setup

- Machine: `75fc68a7-de9f-451f-ae21-292aa86ad032` (`ank-mac`), protocol v5.
- Workspace: `/Users/notacoder/Desktop/test`, one subdirectory per run.
- OpenAI account: `3647c297-4e47-4c3d-9970-06f8719bcf77`.
- Fireworks account: `c8ba0b6c-4174-4898-8d02-33c343074fdc`.
- Tested models: OpenAI `gpt-5.6-sol` twice; Fireworks GLM 5.3 Flash and
  DeepSeek V4.1 Flash. First runs use medium reasoning, second runs max.
- Fixtures: three-shape PNG, paginated text, 2,501-line text, a 5 MiB + 1 byte
  file, and an ambiguous replacement target.

## Four completed runs

| Run | Model | Reasoning | Session | Result |
|---|---|---|---|---|
| openai-1 | gpt-5.6-sol | medium | `ses_3a504c4f-d3e3-4d6c-8575-2165be06508a` | 19/19 passed |
| openai-2 | gpt-5.6-sol | max | `ses_b273095d-8f2b-47c9-9fc4-3ef0e852381e` | 19/19 passed |
| fireworks-1 | accounts/fireworks/models/glm-5p3-flash | medium | `ses_969613c2-623d-4a1b-aee7-3bbf5f8f0346` | 19/19 passed |
| fireworks-2 | accounts/fireworks/models/deepseek-v4p1-flash | max | `ses_4e12604f-1830-424b-9ce7-eae6233c3dd8` | 19/19 passed |

Each session finished idle, with zero active operations, no pending inputs and no
processing error. Each produced 33 transcript rows, 10 successful LLM jobs and
17 execution jobs.

### Features exercised on every run

- All four tool types in one model response; two independent bash commands
  overlapped on this Mac, verified using their actual start/end timestamps.
- Same-file write followed by a two-replacement edit within the batch. Exact
  UTF-8 bytes were checked locally, including accented text, emoji and a checkmark.
- Text offset/limit and 2,000-line output truncation.
- PNG read → Cloudflare Images URL → provider vision input. All four runs'
  responses correctly identified red square, green circle, blue triangle from
  left to right. Image delivery returned HTTP 200 with an image content type.
- Both steering inputs were durably queued together and reflected in the next
  answer after the batch.
- Missing file, 5 MiB + 1 byte file, ambiguous edit, bash exit 7, and bash timeout
  became model-visible tool errors. The ambiguous target remained unchanged, and
  the model continued with a successful read.
- Soft cancellation drained the active command and prevented the next model turn.
  Input received while cancelled remained queued until explicit resume.
- Duplicate cancellation input was deduplicated. A stale run-scoped cancel did
  not cancel the resumed run.
- Resume completed a write/read sequence and retained the original conversation
  recall marker.

### Gateway and storage audit

All **40 LLM jobs and 68 execution jobs** reached terminal states and all
**108 callback deliveries** completed with HTTP 204. The failed filesystem
operations above are intentional error cases, not infrastructure failures.
All execution responses used protocol v5.

The audit compared every retained LLM request's entire message array against the
corresponding prefix of the final transcript. Native assistant/reasoning content
and tool image URLs were replayed unchanged, with `previousJobId: null`.
Tool results appeared in model-call order. Provider reasoning, parallel-tools and
cache options matched the session configuration. Each edit/write job was submitted
only after the previous mutation had finished.

One successful edit callback was deliberately redelivered. It returned HTTP 204
again without changing the file bytes or modification time. Final gateway checks
found no queued/running/retry-wait LLM jobs and no queued/dispatching/waiting-response
execution jobs. The machine remained online.

## Machine access issue found

The first OpenAI and Fireworks sessions could write/edit files, but reads stalled
and bash timed out without output. macOS TCC logged that the updated daemon's code
signature did not match its existing Full Disk Access grant. Sampling the daemon
showed four filesystem read threads blocked inside `open`.

The user restored permission. Both interrupted sessions drained to `cancelled`
with zero active tools, and fresh verification sessions were started. No harness
code change was made for this issue. Interrupted session IDs:

- OpenAI: `ses_a88c7145-99f1-4a0d-88f8-ae1528205886`.
- Fireworks: `ses_3eddaf90-17f1-4fff-bfff-c5e213d29fc2`.

The interrupted sessions retain two queued steering messages each and should not
be resumed as production work.

## Verified API validation

Production creation rejected these configurations with HTTP 400 `INVALID_CONFIG`:
nonvision GLM 5.3, unsupported reasoning value, relative cwd, and an unknown
`compaction` field.

## Redeployment and compatibility checks

The unchanged host was redeployed during OpenAI run 2's initial tool batch. Before
redeployment the session had four active tools and two queued steering inputs;
after deployment it had two active tools and both steering inputs intact. It then
completed the batch and correctly consumed both steering messages. The resulting
host version is `e69889e6-f1bb-4e1d-8d7f-e4e521e0cd8e`. This verifies continuity
across a production redeployment; it does not prove any specific crash timing.

A separate `minimal-bash/v7` session, `ses_5025c1d1-c5a8-48c8-b88f-9239e261367b`,
passed a live LLM → bash → LLM regression through the redeployed shared workers.

One standalone transcript-inspection request returned HTTP 503 `UNAVAILABLE`.
The next read succeeded and the session continued normally. The four test runners
were unaffected by that inspection failure. The exact underlying cause was not
established; callers should honor the API's retry instruction and reuse event/request
identities when retrying writes.

### Callback retry observed

Fireworks run 2's LLM job `d56e9ea2-f337-4f9e-891d-e52b8c253c48` had one
callback attempt return HTTP 503 at 11:27:31 UTC. The gateway retried automatically
and received HTTP 204 at 11:27:57 UTC. This accounts for the only unsuccessful
callback attempt among these 108 deliveries. All other initial deliveries
succeeded on their first attempt. It added latency without losing or duplicating
messages or tools.

The local Wrangler credential could deploy and audit Workers, but the historical
Observability query returned HTTP 403, so retained Worker error logs could not be
retrieved with that credential. No root cause for the transient 503 is asserted.

## Scope and retained resources

These tests establish the listed flows for OpenAI Sol at medium/max, Fireworks
GLM 5.3 Flash at medium and DeepSeek V4.1 Flash at max. They do not live-test Kimi,
other OpenAI models, every reasoning tier, large-scale concurrency, or context
exhaustion. Malformed callbacks/responses, fatal sibling drainage and payload-bound
cases remain covered by the local harness/host tests rather than production fault
injection. Live vision worked with the existing provider adapters; no image
conversion changes were necessary.

Test files, uploaded images and session transcripts are retained for inspection.
There are no temporary public worker routes. Current worker secrets were preserved.

## Evidence

Private local evidence and test scripts are in:
`/var/folders/1n/t7lbn2t179zg_xjbmn62ypmr0000gn/T/pi-harness-production-5v08wcbe`.
The path is also saved in `/tmp/pi-harness-production-path`. Evidence includes
deployment logs/audits, session transcripts, API receipts, and machine-access
logs. It is not committed because transcripts contain provider-native private
reasoning envelopes. Both temporary gateway verification keys were revoked, their rejection was
confirmed with HTTP 401, and the local plaintext key files were removed. Worker
credentials remain unchanged.
